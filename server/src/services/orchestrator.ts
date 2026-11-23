import {
  buildInterpretContext,
  expectedField,
  isRestrictedTopic,
  looksLikeQuestion,
  NEUTRAL_REPLY,
  parseWorkflowState,
  reprompt,
  respond,
  RESTRICTED_REPLY,
  runAiTurn,
  startClarification,
  uploadAcknowledgement,
} from '@tajir/shared';
import type {
  Application,
  AssistantContent,
  Completion,
  EngineContext,
  EngineResult,
  HistoryItem,
  WorkflowState,
  WorkflowStep,
} from '@tajir/shared';
import { documentLabel } from '@tajir/shared';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AiProviderError, AiUnavailableError } from '../ai/types.js';
import type { AiProvider } from '../ai/types.js';
import { classifyDocumentQuestion, focusDocumentIdsOf } from '../documentChat/answer.js';
import type { DocumentAnswers, DocumentSource } from '../documentChat/answer.js';
import type { ConversationRecord, MessageKind, User } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { Repositories } from '../repositories/types.js';
import { createApplicationSchema, patchApplicationSchema } from './applications.js';
import type { ApplicationService, ApplicationView } from './applications.js';

/**
 * The seam between the chat API and the AI.
 *
 * Every turn follows the same path:
 *   1. read the stored workflow state and validate it,
 *   2. let the AI (or, without one, the deterministic rules) read the user's message,
 *   3. hand whatever it proposed to the workflow engine, which validates each value,
 *   4. carry out the effects the engine asks for through the application service, and
 *   5. return the engine's reply and the new state.
 *
 * The AI provider is given no repository and no service. It cannot read or write
 * anything: it returns a proposal and the code here decides. Records change only
 * in step 4, through the same validated service the REST API uses.
 */

/** What the user did in this turn. */
export type TurnInput =
  | { type: 'text'; text: string }
  | { type: 'select'; step: WorkflowStep; cardId: string }
  | { type: 'confirm'; step: WorkflowStep }
  | { type: 'clarify'; applicationId: string }
  | { type: 'uploaded'; applicationId: string; requirementId: string }
  /** The user attached a file in the chat. It has already been uploaded and belongs to them. */
  | { type: 'document_uploaded'; documentId: string };

export interface OrchestratorInput {
  user: User;
  conversation: ConversationRecord;
  input: TurnInput;
  /** Earlier messages, oldest first, not including this turn. */
  history: HistoryItem[];
}

export interface OrchestratorMessage {
  kind: MessageKind;
  text?: string;
  payload?: unknown;
}

/** How the turn was handled. Safe to log and to return: it holds no personal data. */
export interface TurnTrace {
  /** "rules": the deterministic engine. "ai": the model was used. "fallback": the model failed and the rules answered. */
  mode: 'rules' | 'ai' | 'fallback';
  /** The provider that answered. When a model failed before it, `skipped` lists those. */
  provider: string;
  skipped?: string[];
  fallbackReason?: string;
  intent?: string;
  applied: string[];
  ignored: string[];
  guard?: string[];
  restricted?: boolean;
  effects: number;
  latencyMs: number;
}

export interface OrchestratorReply {
  messages: OrchestratorMessage[];
  /** The new workflow state, as decided by the backend. */
  workflow: WorkflowState;
  quickReplies: string[];
  trace: TurnTrace;
}

export interface Orchestrator {
  reply(input: OrchestratorInput): Promise<OrchestratorReply>;
}

export interface OrchestratorDeps {
  ai: AiProvider;
  applications: ApplicationService;
  repos: Repositories;
  clock: () => Date;
  newId?: () => string;
  log?: (trace: TurnTrace) => void;
  /** Answers questions about the user's own uploaded documents. Without it, such questions go the normal way. */
  documentAnswers?: DocumentAnswers;
}

// ------------------------------------------------------------------ helpers

/** Answers typed into these fields are free text, so a question must not be mistaken for an answer. */
const FREE_TEXT_FIELDS = new Set(['activity', 'companyName', 'description', 'shareholders', 'financeAmount', 'informationAnswer']);

const text = (value: string): AssistantContent => ({ kind: 'text', text: value });

export function toApplication(view: ApplicationView): Application {
  return { id: view.id, service: view.service, title: view.title, subtitle: view.subtitle, details: view.details, events: view.events };
}

/** Cards keep their fields in the payload. Text stays in the text column. */
export function toMessage(content: AssistantContent): OrchestratorMessage {
  if (content.kind === 'text') return { kind: 'text', text: content.text };
  const { kind, ...payload } = content;
  return { kind, payload };
}

const firstNameOf = (name: string) => name.trim().split(/\s+/)[0] || name;

// ------------------------------------------------------------- orchestrator

export function createOrchestrator({ ai, applications, repos, clock, newId = randomUUID, log = () => undefined, documentAnswers }: OrchestratorDeps): Orchestrator {
  async function loadContext(user: User): Promise<{ ctx: EngineContext; views: ApplicationView[] }> {
    const views = await applications.list(user);
    const documents = (await repos.documents.listByUser(user.id, 500)).map((d) => ({ typeId: d.typeId }));
    const company = (await repos.businessProfiles.findPrimaryCompany(user.id))?.name ?? user.name;
    return {
      views,
      ctx: {
        applications: views.map(toApplication),
        documents,
        user: { name: user.name, firstName: firstNameOf(user.name), company },
        now: clock(),
        newId,
      },
    };
  }

  /** The deterministic path. A question typed into a free-text step is never taken as the answer. */
  function rulesTurn(wf: WorkflowState, input: string, ctx: EngineContext, isQuickReply: boolean): EngineResult {
    const field = expectedField(wf, ctx);
    if (!isQuickReply && field && FREE_TEXT_FIELDS.has(field) && looksLikeQuestion(input)) {
      const again = reprompt(wf, ctx);
      return {
        workflow: wf,
        replies: [text(isRestrictedTopic(input) ? RESTRICTED_REPLY : NEUTRAL_REPLY), ...again.replies],
        quickReplies: again.quickReplies,
        effects: [],
      };
    }
    return respond(wf, { type: 'text', text: input }, ctx);
  }

  /** Carries out what the engine asked for, through the validated application service. */
  async function runEffects(
    result: EngineResult,
    user: User,
  ): Promise<{ workflow: WorkflowState; replies: AssistantContent[]; quickReplies: string[] }> {
    let workflow = result.workflow;
    const replies = [...result.replies];
    let quickReplies = result.quickReplies;

    for (const effect of result.effects) {
      let view: ApplicationView;
      try {
        if (effect.type === 'submit_company') {
          view = await applications.create(user, createApplicationSchema.parse({ service: 'company_registration', company: effect.company }));
        } else if (effect.type === 'submit_finance') {
          view = await applications.create(user, createApplicationSchema.parse({ service: 'working_capital_finance', finance: effect.finance }));
        } else {
          view = await applications.patch(
            user,
            effect.applicationId,
            patchApplicationSchema.parse({ action: 'provide_information', requirementId: effect.requirementId, value: effect.value }),
          );
        }
      } catch (error) {
        // Validation or workflow refusals are reported plainly and nothing is changed.
        // Anything else is a real fault and is left to the caller.
        if (error instanceof HttpError && error.status < 500) {
          replies.push(text(`I could not record that: ${error.message}. Nothing has been changed, so you can correct it and try again.`));
          break;
        }
        if (error instanceof ZodError) {
          replies.push(text('I could not record that because some details were not valid. Nothing has been changed.'));
          break;
        }
        throw error;
      }
      const completion: Completion = effect.done(toApplication(view));
      workflow = completion.workflow;
      replies.push(...completion.replies);
      quickReplies = completion.quickReplies;
    }
    return { workflow, replies, quickReplies };
  }

  return {
    async reply({ user, conversation, input, history }) {
      const started = Date.now();
      const { ctx, views } = await loadContext(user);
      // Stored state is not trusted either: anything corrupt or inconsistent starts over.
      const wf = parseWorkflowState(conversation.workflow);
      const trace: TurnTrace = { mode: 'rules', provider: ai.name, applied: [], ignored: [], effects: 0, latencyMs: 0 };

      let result: EngineResult;
      let documentSources: DocumentSource[] = [];

      // A file attached in the chat has already been uploaded by the documents API, as the user. This only
      // acknowledges it, with a card that follows its progress, and changes nothing.
      if (input.type === 'document_uploaded') {
        const doc = await repos.documents.findById(user.id, input.documentId);
        if (!doc) throw new HttpError(404, 'Document not found');
        trace.intent = 'document_uploaded';
        trace.latencyMs = Date.now() - started;
        log(trace);
        return {
          messages: [
            { kind: 'document', payload: { documentId: doc.id, name: doc.originalName, typeLabel: documentLabel(doc.typeId), status: doc.processingStatus } },
            {
              kind: 'text',
              text: `I've received ${doc.originalName}. ${
                doc.processingStatus === 'completed' || doc.processingStatus === 'partially_completed'
                  ? 'It has been read, so you can ask me about it now.'
                  : doc.processingStatus === 'failed'
                    ? `It could not be read${doc.errorMessage ? `: ${doc.errorMessage}` : '.'}`
                    : "I'm reading it now and you can follow its progress above. Once it's ready, ask me anything about it."
              }`,
            },
          ],
          workflow: wf,
          quickReplies: conversation.quickReplies.slice(0, 8),
          trace,
        };
      }

      switch (input.type) {
        case 'select':
        case 'confirm':
          // Buttons never need a model: the engine validates the choice itself.
          result = respond(wf, input, ctx);
          break;

        case 'clarify': {
          const app = ctx.applications.find((a) => a.id === input.applicationId);
          if (!app) throw new HttpError(404, 'Application not found');
          result = startClarification(app);
          break;
        }

        case 'uploaded': {
          const view = views.find((v) => v.id === input.applicationId);
          if (!view) throw new HttpError(404, 'Application not found');
          const requirement = view.requirements.find((r) => r.id === input.requirementId);
          // Only a document that really is on record is acknowledged.
          if (!requirement || requirement.kind !== 'document' || !requirement.done) {
            result = {
              workflow: wf,
              replies: [text('I cannot see that document on record yet. Please upload it from the application page.')],
              quickReplies: [],
              effects: [],
            };
          } else {
            result = uploadAcknowledgement(wf, toApplication(view), requirement.label);
          }
          break;
        }

        default: {
          const isQuickReply = conversation.quickReplies.some((q) => q.trim().toLowerCase() === input.text.trim().toLowerCase());
          // Questions about the user's own documents are answered from those documents, and change nothing. A file just
          // attached in this conversation is what "it" and "this document" mean, so the conversation's recent attachments
          // are looked at; the answer step checks each one against the user's own documents.
          let documentAnswer = null;
          if (!isQuickReply && documentAnswers) {
            const hasDocuments = (await repos.documents.countByUser(user.id)) > 0;
            const focus = hasDocuments ? focusDocumentIdsOf(await repos.messages.list(user.id, conversation.id, 12)) : [];
            const intent = classifyDocumentQuestion(input.text, { hasDocuments, hasFocus: focus.length > 0 });
            if (intent) {
              const pendingDocuments = views.flatMap((v) => v.requirements.filter((r) => r.kind === 'document' && !r.done).map((r) => ({ label: r.label, application: v.id })));
              // An implicit question that the documents cannot answer goes to the normal assistant instead.
              documentAnswer = await documentAnswers.answer(user, input.text, { pendingDocuments, focusDocumentIds: focus, fallThrough: intent === 'implicit' });
            }
          }
          if (documentAnswer) {
            const answer = documentAnswer;
            documentSources = answer.sources;
            trace.mode = answer.mode === 'ai' ? 'ai' : 'rules';
            trace.intent = 'document_question';
            result = { workflow: wf, replies: [text(answer.text)], quickReplies: conversation.quickReplies, effects: [] };
            break;
          }
          if (ai.kind === 'rules' || isQuickReply) {
            result = rulesTurn(wf, input.text, ctx, isQuickReply);
            break;
          }
          let proposal;
          try {
            proposal = await ai.interpret(
              { text: input.text, context: buildInterpretContext(wf, ctx, history) },
              {
                // Which model actually answered, and which ones were tried and failed first.
                onProvider: (name) => {
                  trace.provider = name;
                },
                onFailure: (name, code) => {
                  trace.skipped = [...(trace.skipped ?? []), `${name}:${code}`];
                },
              },
            );
          } catch (error) {
            // Any failure of the model leaves the user with the deterministic rules, never with an error.
            trace.mode = 'fallback';
            trace.fallbackReason = error instanceof AiUnavailableError || error instanceof AiProviderError ? error.code : 'unknown';
            result = rulesTurn(wf, input.text, ctx, false);
            break;
          }
          const turn = runAiTurn(wf, proposal, input.text, ctx);
          trace.mode = 'ai';
          trace.intent = turn.report.intent;
          trace.applied = turn.report.applied;
          trace.ignored = turn.report.ignored;
          trace.guard = turn.report.guard;
          trace.restricted = turn.report.restricted;
          result = turn.result;
        }
      }

      trace.effects = result.effects.length;
      const settled = await runEffects(result, user);
      trace.latencyMs = Date.now() - started;
      log(trace);

      const messages = settled.replies.map(toMessage);
      // The documents an answer came from are attached to it, so the screen can show where it is from.
      if (documentSources.length > 0 && messages[0]?.kind === 'text') messages[0] = { ...messages[0], payload: { sources: documentSources } };

      return {
        messages,
        workflow: settled.workflow,
        quickReplies: settled.quickReplies.slice(0, 8),
        trace,
      };
    },
  };
}
