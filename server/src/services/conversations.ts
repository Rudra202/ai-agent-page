import {
  draftConsistencyProblem,
  draftPatchSchema,
  INITIAL_WORKFLOW,
  mergeCompanyDraft,
  parseWorkflowState,
  reprompt,
  stepForDraft,
  WORKFLOW_STEPS,
  welcomeContent,
} from '@tajir/shared';
import type { HistoryItem, WorkflowState } from '@tajir/shared';
import { z } from 'zod';
import { MESSAGE_KINDS } from '../domain/entities.js';
import type { ConversationRecord, MessageRecord, User } from '../domain/entities.js';
import { HttpError } from '../middleware/errorHandler.js';
import type { Repositories } from '../repositories/types.js';
import { APPLICATION_REFERENCE } from './applications.js';
import { toMessage } from './orchestrator.js';
import type { Orchestrator, OrchestratorMessage, TurnInput } from './orchestrator.js';

export const createConversationSchema = z.object({ title: z.string().trim().min(1).max(120).optional() }).strict();

const ALL_STEPS = [...WORKFLOW_STEPS.company_registration, ...WORKFLOW_STEPS.working_capital_finance] as [string, ...string[]];

/** A typed message. */
const textMessageSchema = z.object({ text: z.string().trim().min(1, 'Type a message').max(500, 'Keep messages under 500 characters') }).strict();

/** A button the user pressed. The words shown in the chat for it are `display`. */
const actionMessageSchema = z
  .object({
    action: z.discriminatedUnion('type', [
      z.object({ type: z.literal('select'), step: z.enum(ALL_STEPS), cardId: z.string().min(1).max(64) }).strict(),
      z.object({ type: z.literal('confirm'), step: z.enum(ALL_STEPS) }).strict(),
      z.object({ type: z.literal('clarify'), applicationId: z.string().regex(APPLICATION_REFERENCE) }).strict(),
      z.object({ type: z.literal('uploaded'), applicationId: z.string().regex(APPLICATION_REFERENCE), requirementId: z.string().min(1).max(96) }).strict(),
      z.object({ type: z.literal('document_uploaded'), documentId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
    ]),
    display: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const postMessageSchema = z.union([textMessageSchema, actionMessageSchema]);

/** An edit to the company draft from the review screen. Checked by the same rules as the conversation. */
export const updateDraftSchema = z.object({ company: draftPatchSchema }).strict();

export interface TurnRequest {
  input: TurnInput;
  /** What is written in the chat as the user's message. */
  display: string;
}

const DEFAULT_DISPLAY: Record<string, string> = {
  select: 'Selected an option',
  confirm: 'Confirm & Submit',
  clarify: 'Continue with the missing items',
  uploaded: 'I uploaded the document',
  document_uploaded: 'I attached a document',
};

/** Turns the request body into a typed turn. Unknown fields and mixed bodies are rejected. */
export function toTurnRequest(body: z.output<typeof postMessageSchema>): TurnRequest {
  if ('text' in body) return { input: { type: 'text', text: body.text }, display: body.text };
  return { input: body.action as TurnInput, display: body.display ?? DEFAULT_DISPLAY[body.action.type] ?? 'Done' };
}

export const DEFAULT_TITLE = 'New chat';
export const MAX_MESSAGES_PER_CONVERSATION = 1000;
const MAX_ASSISTANT_TEXT = 2000;
const HISTORY_FETCH = 8;

export interface ConversationView {
  id: string;
  title: string;
  status: 'active' | 'archived';
  lastMessageAt: string;
  createdAt: string;
}

export interface MessageView {
  id: string;
  role: 'user' | 'assistant';
  kind: string;
  text: string | null;
  payload: unknown;
  createdAt: string;
}

const toConversationView = (c: ConversationRecord): ConversationView => ({
  id: c.id,
  title: c.title,
  status: c.status,
  lastMessageAt: c.lastMessageAt.toISOString(),
  createdAt: c.createdAt.toISOString(),
});

const toMessageView = (m: MessageRecord): MessageView => ({
  id: m.id,
  role: m.role,
  kind: m.kind,
  text: m.text ?? null,
  payload: m.payload ?? null,
  createdAt: m.createdAt.toISOString(),
});

/** Earlier plain-text messages, short and oldest first, for the model's context. */
const toHistory = (messages: MessageRecord[]): HistoryItem[] =>
  messages.filter((m) => m.kind === 'text' && m.text).map((m) => ({ role: m.role, text: m.text as string }));

export interface ConversationServiceDeps {
  repos: Repositories;
  orchestrator: Orchestrator;
  clock: () => Date;
}

export function createConversationService({ repos, orchestrator, clock }: ConversationServiceDeps) {
  async function owned(user: User, id: string): Promise<ConversationRecord> {
    const conversation = await repos.conversations.get(user.id, id);
    if (!conversation) throw new HttpError(404, 'Conversation not found');
    return conversation;
  }

  return {
    async create(user: User, title?: string): Promise<{ conversation: ConversationView; messages: MessageView[]; quickReplies: string[]; workflow: Record<string, unknown> }> {
      const welcome = welcomeContent();
      const conversation = await repos.conversations.create({
        userId: user.id,
        title: title ?? DEFAULT_TITLE,
        workflow: { ...INITIAL_WORKFLOW, company: {}, finance: {} },
        quickReplies: welcome.quickReplies,
      });
      const messages: MessageRecord[] = [];
      for (const content of welcome.replies) {
        const message = toMessage(content);
        messages.push(await repos.messages.append({ conversationId: conversation.id, userId: user.id, role: 'assistant', kind: message.kind, text: message.text, payload: message.payload }));
      }
      return { conversation: toConversationView(conversation), messages: messages.map(toMessageView), quickReplies: conversation.quickReplies, workflow: conversation.workflow };
    },

    async list(user: User): Promise<ConversationView[]> {
      return (await repos.conversations.list(user.id, 50)).map(toConversationView);
    },

    async get(user: User, id: string): Promise<{ conversation: ConversationView; workflow: Record<string, unknown>; quickReplies: string[]; messages: MessageView[] }> {
      const conversation = await owned(user, id);
      const messages = await repos.messages.list(user.id, conversation.id, 200);
      return {
        conversation: toConversationView(conversation),
        workflow: conversation.workflow,
        quickReplies: conversation.quickReplies,
        messages: messages.map(toMessageView),
      };
    },

    /**
     * The review screen lets the user correct the draft by hand. The edit is validated
     * like anything typed in the chat, the step is worked out from the draft, and only a
     * draft that has not been submitted can change.
     */
    async updateDraft(
      user: User,
      id: string,
      input: z.output<typeof updateDraftSchema>,
    ): Promise<{ workflow: WorkflowState; quickReplies: string[] }> {
      const conversation = await owned(user, id);
      const workflow = parseWorkflowState(conversation.workflow);
      if (workflow.type !== 'company_registration' || workflow.step === 'submitted' || workflow.step === 'intent') {
        throw new HttpError(409, 'There is no company setup in progress to edit.');
      }

      const company = mergeCompanyDraft(workflow.company, input.company);
      const problem = draftConsistencyProblem(company);
      if (problem) throw new HttpError(422, problem);

      const next: WorkflowState = { ...workflow, company, step: stepForDraft(company) };
      const documents = (await repos.documents.listByUser(user.id, 500)).map((d) => ({ typeId: d.typeId }));
      const quickReplies = reprompt(next, {
        applications: [],
        documents,
        user: { name: user.name, firstName: user.name.trim().split(/\s+/)[0] || user.name, company: user.name },
        now: clock(),
        newId: () => 'draft',
      }).quickReplies.slice(0, 8);

      await repos.conversations.update(user.id, conversation.id, {
        workflow: next as unknown as Record<string, unknown>,
        quickReplies,
        lastMessageAt: clock(),
      });
      return { workflow: next, quickReplies };
    },

    async postMessage(
      user: User,
      id: string,
      request: TurnRequest,
    ): Promise<{ conversation: ConversationView; messages: MessageView[]; quickReplies: string[]; workflow: Record<string, unknown>; assistant: { mode: string } }> {
      const conversation = await owned(user, id);
      if ((await repos.messages.count(user.id, conversation.id)) >= MAX_MESSAGES_PER_CONVERSATION) {
        throw new HttpError(409, 'This conversation is full. Start a new chat.');
      }

      const history = toHistory(await repos.messages.list(user.id, conversation.id, HISTORY_FETCH));
      // The user's message is saved first, so it is never lost if the assistant fails.
      const userMessage = await repos.messages.append({ conversationId: conversation.id, userId: user.id, role: 'user', kind: 'text', text: request.display });

      let reply;
      try {
        reply = await orchestrator.reply({ user, conversation, input: request.input, history });
      } catch (error) {
        // An answer for the user (such as an unknown application) is passed on. Faults are not detailed.
        if (error instanceof HttpError && error.status < 500) throw error;
        console.error('[assistant]', error instanceof Error ? error.message : String(error));
        throw new HttpError(502, 'The assistant is unavailable right now. Your message was saved.');
      }

      const stored: OrchestratorMessage[] = reply.messages;
      for (const message of stored) {
        // Whatever the assistant produced is checked before it is stored.
        if (!MESSAGE_KINDS.includes(message.kind) || (message.text !== undefined && message.text.length > MAX_ASSISTANT_TEXT)) {
          throw new HttpError(502, 'The assistant produced an invalid reply. Your message was saved.');
        }
      }
      const assistantMessages: MessageRecord[] = [];
      for (const message of stored) {
        assistantMessages.push(
          await repos.messages.append({ conversationId: conversation.id, userId: user.id, role: 'assistant', kind: message.kind, text: message.text, payload: message.payload }),
        );
      }

      const updated = await repos.conversations.update(user.id, conversation.id, {
        workflow: reply.workflow as unknown as Record<string, unknown>,
        quickReplies: reply.quickReplies,
        lastMessageAt: clock(),
        ...(conversation.title === DEFAULT_TITLE && request.input.type === 'text' ? { title: request.display.slice(0, 60) } : {}),
      });
      const current = updated ?? conversation;
      return {
        conversation: toConversationView(current),
        messages: [userMessage, ...assistantMessages].map(toMessageView),
        quickReplies: reply.quickReplies,
        workflow: current.workflow,
        assistant: { mode: reply.trace.mode },
      };
    },
  };
}

export type ConversationService = ReturnType<typeof createConversationService>;
