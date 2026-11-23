import type {
  ActivityFilter,
  DocumentUnderstanding,
  ApplicationProgress,
  ApplicationStatus,
  CompanyDraft,
  DetailRow,
  Requirement,
  WorkflowEvent,
  WorkflowState,
  WorkflowType,
} from '@tajir/shared';

/** What the server returns. These mirror the server's view types. */

export interface UserView {
  id: string;
  name: string;
  email: string;
  company: string | null;
}

export interface ApplicationView {
  id: string;
  service: WorkflowType;
  title: string;
  subtitle: string;
  status: ApplicationStatus;
  statusLabel: string;
  activityFilter: ActivityFilter;
  progress: ApplicationProgress;
  requirements: Requirement[];
  details: DetailRow[];
  events: WorkflowEvent[];
  nextAction: { text: string; needsAction: boolean };
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  simulation: { available: boolean; nextStep: string | null };
}

export type DocumentProcessingStatus = 'uploaded' | 'queued' | 'processing' | 'retrying' | 'completed' | 'partially_completed' | 'failed';
export type DocumentAiStatus = 'not_requested' | 'pending' | 'completed' | 'skipped' | 'unavailable' | 'failed';

export interface DocumentView {
  id: string;
  typeId: string;
  label: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  applicationId: string | null;
  requirementId: string | null;
  processingStatus: DocumentProcessingStatus;
  aiStatus: DocumentAiStatus;
  /** What the content looks like, as read by the system. A reading, never a verification. */
  detectedType: string | null;
  /** A short reason, when reading failed or only partly worked. */
  errorMessage: string | null;
  retryCount: number;
  processedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What was read from a document. The AI part (`structured`) is an interpretation and is labelled as one. */
export interface DocumentExtractionView {
  method: 'pdf_text' | 'ocr' | 'pdf_ocr';
  detectedType: string;
  confidence: 'high' | 'medium' | 'low';
  pageCount: number | null;
  textLength: number;
  truncated: boolean;
  structured: DocumentUnderstanding | null;
  ai: { status: DocumentAiStatus; provider: string | null; model: string | null; error: string | null };
}

export interface DocumentDetailView extends DocumentView {
  extraction: DocumentExtractionView | null;
}

export interface DocumentStatusView {
  id: string;
  processingStatus: DocumentProcessingStatus;
  aiStatus: DocumentAiStatus;
  detectedType: string | null;
  errorMessage: string | null;
  retryCount: number;
  processedAt: string | null;
  updatedAt: string;
  /** True while the system is still working on it. */
  active: boolean;
}

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

export interface ConversationState {
  conversation: ConversationView;
  messages: MessageView[];
  quickReplies: string[];
  workflow: WorkflowState;
}

export interface TurnResponse extends ConversationState {
  assistant: { mode: 'rules' | 'ai' | 'fallback' };
}

/** One thing the user did in the chat: typed text or pressed a button. */
export type TurnBody =
  | { text: string }
  | {
      action:
        | { type: 'select'; step: string; cardId: string }
        | { type: 'confirm'; step: string }
        | { type: 'clarify'; applicationId: string }
        | { type: 'uploaded'; applicationId: string; requirementId: string }
        | { type: 'document_uploaded'; documentId: string };
      display?: string;
    };

export interface HealthView {
  status: string;
  db: 'mongodb' | 'memory' | 'unavailable';
  /** Which assistant answers. "rules" means no AI model is connected. */
  ai: 'gemini' | 'openai' | 'rules';
  /** The model tried when the first one cannot answer, if there is one. */
  aiBackup: 'gemini' | 'openai' | null;
  storage: string;
}

export interface UploadFields {
  typeId: string;
  applicationId?: string;
  requirementId?: string;
  /** If the same file is already one of the user's documents, use that one instead of keeping a second copy. */
  reuseExisting?: boolean;
}

/** Everything the app asks of the server. The HTTP implementation is in httpApi.ts. */
export interface ApiClient {
  health(): Promise<HealthView>;
  auth: {
    /** The signed-in user, or null when there is no valid session. */
    me(): Promise<UserView | null>;
    login(input: { email: string; password: string }): Promise<UserView>;
    register(input: { name: string; email: string; password: string; company?: string }): Promise<UserView>;
    logout(): Promise<void>;
  };
  applications: {
    list(): Promise<ApplicationView[]>;
    get(id: string): Promise<ApplicationView>;
    simulateNext(id: string): Promise<ApplicationView>;
  };
  documents: {
    list(): Promise<DocumentView[]>;
    get(id: string): Promise<DocumentDetailView>;
    status(id: string): Promise<DocumentStatusView>;
    upload(file: File, fields: UploadFields): Promise<{ document: DocumentView; application?: ApplicationView; reused?: boolean }>;
    /** Removes the document, its file and what was read from it. */
    remove(id: string): Promise<void>;
    /** Reads the document again. The work is queued: follow `status`. */
    reprocess(id: string): Promise<DocumentStatusView>;
    /** The file itself, fetched with the user's session. "view" is for showing in the app, "download" for saving. */
    file(id: string, mode: 'view' | 'download'): Promise<Blob>;
  };
  conversations: {
    list(): Promise<ConversationView[]>;
    create(): Promise<ConversationState>;
    get(id: string): Promise<ConversationState>;
    send(id: string, turn: TurnBody): Promise<TurnResponse>;
    updateDraft(id: string, company: Partial<CompanyDraft>): Promise<{ workflow: WorkflowState; quickReplies: string[] }>;
  };
}
