import {
  activityFilterFor,
  APPLICATION_STATUS_LABELS,
  createSampleApplications,
  createdAtOf,
  detailRowsOf,
  INITIAL_WORKFLOW,
  mergeCompanyDraft,
  nextAction,
  nextExternalStep,
  parseWorkflowState,
  progressOf,
  provideRequirement,
  requirementsOfApp,
  respond,
  SAMPLE_DOCUMENT_TYPES,
  settleLocally,
  simulateNext,
  startClarification,
  statusOf,
  stepForDraft,
  submittedAtOf,
  updatedAtOf,
  uploadAcknowledgement,
  welcomeContent,
  documentLabel,
} from '@tajir/shared';
import type { Application, AssistantContent, EngineContext, EngineInput, EngineResult, WorkflowState } from '@tajir/shared';
import { ApiError } from '../api/http';
import type { ApiClient, ApplicationView, ConversationState, DocumentDetailView, DocumentExtractionView, DocumentProcessingStatus, DocumentStatusView, DocumentView, MessageView, TurnBody, TurnResponse, UserView } from '../api/types';

/**
 * A stand-in for the Tajir server for UI tests: the same API surface, kept in memory,
 * with the real shared workflow engine behind it. It is not the product: the real
 * server is covered by the server tests and by the browser tests.
 */

export const NOW = new Date('2026-11-21T10:00:00Z');

export const TEST_USER: UserView = { id: 'user-1', name: 'Ahmed Al Mansoori', email: 'ahmed@abctrading.example', company: 'ABC Trading LLC' };

export interface FakeApiOptions {
  /** The signed-in user, or null for a visitor. */
  user?: UserView | null;
  /** Start with the sample applications and documents of the old demo. Defaults to true. */
  seed?: boolean;
  /** Which assistant the server reports. Defaults to "rules": no AI model connected. */
  ai?: 'gemini' | 'openai' | 'rules';
  /** The backup model the server reports. Defaults to none. */
  aiBackup?: 'gemini' | 'openai' | null;
  /** How replies say they were produced. Defaults to "rules". */
  replyMode?: 'rules' | 'ai' | 'fallback';
  /** Start with a conversation already at this workflow state. */
  workflow?: WorkflowState;
  /** Everything the fake server "knows" about accounts that can sign in. */
  accounts?: Array<{ email: string; password: string; name: string; company?: string }>;
}

export interface FakeApi extends ApiClient {
  /** Makes the next call to `method` (for example "conversations.send") fail with this error. */
  failNext(method: string, error: Error): void;
  /** Number of calls made to `method`. */
  calls(method: string): number;
  /** The documents as the server holds them. */
  readonly stored: DocumentView[];
  /** Plays the part of the worker: moves a document on, and says what was read from it. */
  finishReading(id: string, patch?: Partial<DocumentView> & { extraction?: DocumentExtractionView | null }): void;
  /** The next typed chat message is answered with this text, naming these documents as its sources. */
  answerNextTextWith(text: string, sources: Array<{ documentId: string; name: string; page?: number }>): void;
}

export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  let counter = 0;
  const newId = () => `id-${(counter += 1)}`;
  let signedIn: UserView | null = options.user === undefined ? TEST_USER : options.user;
  const accounts = [...(options.accounts ?? [])];

  let applications: Application[] = options.seed === false ? [] : createSampleApplications(NOW, newId);
  const docs: DocumentView[] =
    options.seed === false
      ? []
      : SAMPLE_DOCUMENT_TYPES.map((typeId) => ({
          id: newId(),
          typeId,
          label: documentLabel(typeId),
          originalName: `${typeId}.pdf`,
          mimeType: 'application/pdf',
          sizeBytes: 120_000,
          sha256: 'x'.repeat(64),
          applicationId: null,
          requirementId: null,
          processingStatus: 'completed' as const,
          aiStatus: 'skipped' as const,
          detectedType: null,
          errorMessage: null,
          retryCount: 0,
          processedAt: NOW.toISOString(),
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        }));

  const extractions = new Map<string, DocumentExtractionView | null>();
  let nextAnswer: { text: string; sources: Array<{ documentId: string; name: string; page?: number }> } | null = null;
  const conversations: Array<{ id: string; messages: MessageView[]; workflow: WorkflowState; quickReplies: string[]; lastMessageAt: string }> = [];
  const failures = new Map<string, Error[]>();
  const callCounts = new Map<string, number>();

  const enter = (method: string) => {
    callCounts.set(method, (callCounts.get(method) ?? 0) + 1);
    const queued = failures.get(method);
    if (queued?.length) throw queued.shift();
  };

  const requireUser = (): UserView => {
    if (!signedIn) throw new ApiError(401, 'Sign in to continue');
    return signedIn;
  };

  const tick = () => new Date(NOW.getTime() + counter * 1000);

  const toView = (app: Application): ApplicationView => {
    const status = statusOf(app);
    const step = nextExternalStep(app.service, app.events);
    return {
      id: app.id,
      service: app.service,
      title: app.title,
      subtitle: app.subtitle,
      status,
      statusLabel: APPLICATION_STATUS_LABELS[status],
      activityFilter: activityFilterFor(status),
      progress: progressOf(app),
      requirements: requirementsOfApp(app),
      details: detailRowsOf(app),
      events: app.events,
      nextAction: nextAction(app),
      createdAt: createdAtOf(app) || NOW.toISOString(),
      updatedAt: updatedAtOf(app) || NOW.toISOString(),
      submittedAt: submittedAtOf(app) ?? null,
      simulation: { available: step !== null, nextStep: step?.label ?? null },
    };
  };

  const toMessage = (content: AssistantContent, role: 'assistant'): MessageView => {
    const base = { id: newId(), role, createdAt: tick().toISOString() };
    if (content.kind === 'text') return { ...base, kind: 'text', text: content.text, payload: null };
    const { kind, ...payload } = content;
    return { ...base, kind, text: null, payload };
  };

  const state = (c: (typeof conversations)[number]): ConversationState => ({
    conversation: { id: c.id, title: 'New chat', status: 'active', lastMessageAt: c.lastMessageAt, createdAt: c.lastMessageAt },
    messages: c.messages,
    quickReplies: c.quickReplies,
    workflow: c.workflow,
  });

  const open = (): (typeof conversations)[number] => {
    const welcome = welcomeContent();
    const c = { id: `conv-${conversations.length + 1}`, messages: welcome.replies.map((r) => toMessage(r, 'assistant')), workflow: INITIAL_WORKFLOW, quickReplies: welcome.quickReplies, lastMessageAt: tick().toISOString() };
    conversations.unshift(c);
    return c;
  };

  const ctx = (): EngineContext => {
    const user = requireUser();
    return {
      applications,
      documents: docs.map((d) => ({ typeId: d.typeId })),
      user: { name: user.name, firstName: user.name.split(' ')[0] ?? user.name, company: user.company ?? user.name },
      now: tick(),
      newId,
    };
  };

  const find = (id: string) => applications.find((a) => a.id === id);

  const statusOf_ = (doc: DocumentView): DocumentStatusView => ({
    id: doc.id,
    processingStatus: doc.processingStatus,
    aiStatus: doc.aiStatus,
    detectedType: doc.detectedType,
    errorMessage: doc.errorMessage,
    retryCount: doc.retryCount,
    processedAt: doc.processedAt,
    updatedAt: doc.updatedAt,
    active: (['uploaded', 'queued', 'processing', 'retrying'] as DocumentProcessingStatus[]).includes(doc.processingStatus),
  });

  const api: FakeApi = {
    failNext(method, error) {
      failures.set(method, [...(failures.get(method) ?? []), error]);
    },
    calls: (method) => callCounts.get(method) ?? 0,
    get stored() {
      return docs;
    },
    finishReading(id, patch = {}) {
      const doc = docs.find((d) => d.id === id);
      if (!doc) throw new Error(`No document ${id}`);
      const { extraction, ...rest } = patch;
      Object.assign(doc, { processingStatus: 'completed', processedAt: tick().toISOString(), updatedAt: tick().toISOString() }, rest);
      if (extraction !== undefined) extractions.set(id, extraction);
    },
    answerNextTextWith(text, sources) {
      nextAnswer = { text, sources };
    },

    async health() {
      enter('health');
      return { status: 'ok', db: 'memory', ai: options.ai ?? 'rules', aiBackup: options.aiBackup ?? null, storage: 'memory' };
    },

    auth: {
      async me() {
        enter('auth.me');
        return signedIn;
      },
      async login({ email, password }) {
        enter('auth.login');
        const account = accounts.find((a) => a.email === email.toLowerCase());
        if (!account || account.password !== password) throw new ApiError(401, 'Invalid email or password');
        signedIn = { id: `user-${account.email}`, name: account.name, email: account.email, company: account.company ?? null };
        return signedIn;
      },
      async register({ name, email, password, company }) {
        enter('auth.register');
        if (accounts.some((a) => a.email === email.toLowerCase())) throw new ApiError(409, 'An account with this email already exists');
        accounts.push({ email: email.toLowerCase(), password, name, company });
        signedIn = { id: `user-${email.toLowerCase()}`, name, email: email.toLowerCase(), company: company ?? null };
        return signedIn;
      },
      async logout() {
        enter('auth.logout');
        signedIn = null;
      },
    },

    applications: {
      async list() {
        enter('applications.list');
        requireUser();
        return applications.map(toView);
      },
      async get(id) {
        enter('applications.get');
        requireUser();
        const app = find(id);
        if (!app) throw new ApiError(404, 'Application not found');
        return toView(app);
      },
      async simulateNext(id) {
        enter('applications.simulateNext');
        requireUser();
        const app = find(id);
        if (!app) throw new ApiError(404, 'Application not found');
        const outcome = simulateNext(app, { now: tick(), newId });
        if (!outcome) throw new ApiError(409, 'There is no step that can be simulated for this application right now');
        applications = applications.map((a) => (a.id === id ? outcome.app : a));
        return toView(outcome.app);
      },
    },

    documents: {
      async list() {
        enter('documents.list');
        requireUser();
        return [...docs];
      },
      async upload(file, fields) {
        enter('documents.upload');
        requireUser();
        if (file.size === 0) throw new ApiError(400, 'That file is empty.');
        // The server compares content; the stand-in compares name and size, which is enough for a test file.
        const same = fields.reuseExisting && !fields.applicationId ? docs.find((d) => d.originalName === file.name && d.sizeBytes === file.size) : undefined;
        if (same) return { document: same, reused: true };
        const document: DocumentView = {
          id: newId(),
          typeId: fields.typeId,
          label: documentLabel(fields.typeId),
          originalName: file.name,
          mimeType: file.type || 'application/pdf',
          sizeBytes: file.size,
          sha256: 'y'.repeat(64),
          applicationId: fields.applicationId ?? null,
          requirementId: fields.requirementId ?? null,
          processingStatus: 'queued',
          aiStatus: 'not_requested',
          detectedType: null,
          errorMessage: null,
          retryCount: 0,
          processedAt: null,
          createdAt: tick().toISOString(),
          updatedAt: tick().toISOString(),
        };
        let view: ApplicationView | undefined;
        if (fields.applicationId && fields.requirementId) {
          const app = find(fields.applicationId);
          if (!app) throw new ApiError(404, 'Application not found');
          const updated = provideRequirement(app, fields.requirementId, { now: tick(), newId }, { actor: 'user', detail: file.name });
          applications = applications.map((a) => (a.id === app.id ? updated : a));
          view = toView(updated);
        }
        docs.unshift(document);
        return { document, application: view };
      },
      async get(id): Promise<DocumentDetailView> {
        enter('documents.get');
        requireUser();
        const doc = docs.find((d) => d.id === id);
        if (!doc) throw new ApiError(404, 'Document not found');
        return { ...doc, extraction: extractions.get(id) ?? null };
      },
      async status(id): Promise<DocumentStatusView> {
        enter('documents.status');
        requireUser();
        const doc = docs.find((d) => d.id === id);
        if (!doc) throw new ApiError(404, 'Document not found');
        return statusOf_(doc);
      },
      async remove(id) {
        enter('documents.remove');
        requireUser();
        const index = docs.findIndex((d) => d.id === id);
        if (index === -1) throw new ApiError(404, 'Document not found');
        docs.splice(index, 1);
        extractions.delete(id);
      },
      async reprocess(id) {
        enter('documents.reprocess');
        requireUser();
        const doc = docs.find((d) => d.id === id);
        if (!doc) throw new ApiError(404, 'Document not found');
        if (doc.processingStatus === 'completed' || doc.processingStatus === 'partially_completed' || doc.processingStatus === 'failed') {
          Object.assign(doc, { processingStatus: 'queued', aiStatus: 'not_requested', errorMessage: null, retryCount: 0, processedAt: null, updatedAt: tick().toISOString() });
        }
        return statusOf_(doc);
      },
      async file(id, mode) {
        enter('documents.file');
        requireUser();
        const doc = docs.find((d) => d.id === id);
        if (!doc) throw new ApiError(404, 'Document not found');
        void mode;
        return new Blob(['%PDF-1.4 fake file bytes'], { type: doc.mimeType });
      },
    },

    conversations: {
      async list() {
        enter('conversations.list');
        requireUser();
        return conversations.map((c) => state(c).conversation);
      },
      async create() {
        enter('conversations.create');
        requireUser();
        return state(open());
      },
      async get(id) {
        enter('conversations.get');
        requireUser();
        const c = conversations.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'Conversation not found');
        return state(c);
      },
      async send(id, turn: TurnBody): Promise<TurnResponse> {
        enter('conversations.send');
        requireUser();
        const c = conversations.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'Conversation not found');
        const context = ctx();
        const wf = parseWorkflowState(c.workflow);

        let display: string;
        let result: EngineResult;
        if ('text' in turn && nextAnswer) {
          const answer = nextAnswer;
          nextAnswer = null;
          const userMessage: MessageView = { id: newId(), role: 'user', kind: 'text', text: turn.text, payload: null, createdAt: tick().toISOString() };
          const reply: MessageView = { id: newId(), role: 'assistant', kind: 'text', text: answer.text, payload: { sources: answer.sources }, createdAt: tick().toISOString() };
          c.messages.push(userMessage, reply);
          return { ...state(c), messages: [userMessage, reply], assistant: { mode: options.replyMode ?? 'rules' } };
        }
        if ('text' in turn) {
          display = turn.text;
          result = respond(wf, { type: 'text', text: turn.text }, context);
        } else {
          display = turn.display ?? 'Done';
          const a = turn.action;
          if (a.type === 'select') result = respond(wf, { type: 'select', step: a.step, cardId: a.cardId } as EngineInput, context);
          else if (a.type === 'confirm') result = respond(wf, { type: 'confirm', step: a.step } as EngineInput, context);
          else if (a.type === 'clarify') {
            const app = find(a.applicationId);
            if (!app) throw new ApiError(404, 'Application not found');
            result = startClarification(app);
          } else if (a.type === 'document_uploaded') {
            const doc = docs.find((d) => d.id === a.documentId);
            if (!doc) throw new ApiError(404, 'Document not found');
            const card: MessageView = { id: newId(), role: 'assistant', kind: 'document', text: null, payload: { documentId: doc.id, name: doc.originalName, typeLabel: documentLabel(doc.typeId), status: doc.processingStatus }, createdAt: tick().toISOString() };
            const note: MessageView = { id: newId(), role: 'assistant', kind: 'text', text: `I have received ${doc.originalName}. I am reading it now and you can follow its progress above. Once it is ready, ask me anything about it.`, payload: null, createdAt: tick().toISOString() };
            const userMessage: MessageView = { id: newId(), role: 'user', kind: 'text', text: turn.display ?? 'Attached a document', payload: null, createdAt: tick().toISOString() };
            c.messages.push(userMessage, card, note);
            return { ...state(c), messages: [userMessage, card, note], assistant: { mode: options.replyMode ?? 'rules' } };
          } else {
            const app = find(a.applicationId);
            if (!app) throw new ApiError(404, 'Application not found');
            const requirement = requirementsOfApp(app).find((r) => r.id === a.requirementId);
            result = requirement?.done
              ? uploadAcknowledgement(wf, app, requirement.label)
              : { workflow: wf, replies: [{ kind: 'text', text: 'I cannot see that document on record yet. Please upload it from the application page.' }], quickReplies: [], effects: [] };
          }
        }

        const settled = settleLocally(result, context);
        applications = settled.applications;
        const userMessage: MessageView = { id: newId(), role: 'user', kind: 'text', text: display, payload: null, createdAt: tick().toISOString() };
        const assistant = settled.replies.map((r) => toMessage(r, 'assistant'));
        c.messages.push(userMessage, ...assistant);
        c.workflow = settled.workflow;
        c.quickReplies = settled.quickReplies;
        c.lastMessageAt = tick().toISOString();
        return { ...state(c), messages: [userMessage, ...assistant], assistant: { mode: options.replyMode ?? 'rules' } };
      },
      async updateDraft(id, company) {
        enter('conversations.updateDraft');
        requireUser();
        const c = conversations.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'Conversation not found');
        const wf = parseWorkflowState(c.workflow);
        if (wf.type !== 'company_registration' || wf.step === 'submitted') throw new ApiError(409, 'There is no company setup in progress to edit.');
        const merged = mergeCompanyDraft(wf.company, company);
        c.workflow = { ...wf, company: merged, step: stepForDraft(merged) };
        return { workflow: c.workflow, quickReplies: c.quickReplies };
      },
    },
  };
  if (options.workflow) {
    const first = open();
    first.workflow = options.workflow;
  }
  return api;
}
