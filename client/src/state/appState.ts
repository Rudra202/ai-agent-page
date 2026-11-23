import { pendingOf } from '@tajir/shared';
import type { Application } from '@tajir/shared';
import type { AttentionItem, UserProfile, VaultDocument } from '../domain/types';
import type { ChatMessage, WorkflowState } from '../features/chat/types';

export { mergeCompanyDraft, stepForDraft } from '@tajir/shared';

export type LoadStatus = 'loading' | 'ready' | 'error';

/**
 * Everything the screens read. It is a copy of what the server holds: the server
 * is the source of truth, and nothing here is stored in the browser.
 */
export interface AppState {
  user: UserProfile;
  documents: VaultDocument[];
  applications: Application[];
  messages: ChatMessage[];
  workflow: WorkflowState;
  quickReplies: string[];
  /** Replies that are on their way. Greater than zero means Tajir is "typing". */
  pendingReplies: number;
  conversationId: string | null;
  load: { status: LoadStatus; error?: string };
  /** The last chat turn that could not be completed, shown with a way to try again. */
  chatError: string | null;
  /** Which assistant answers first: Gemini or OpenAI, or the built-in rules when no model is connected. Null until known. */
  aiMode: 'gemini' | 'openai' | 'rules' | null;
  /** The model used when the first one cannot answer. Null when there is none. */
  aiBackup: 'gemini' | 'openai' | null;
  /** How the newest reply was produced. "fallback" means the model could not be reached and the built-in rules answered. */
  lastReplyMode: 'rules' | 'ai' | 'fallback' | null;
}

export const MAX_MESSAGES = 300;

export function appendMessages(messages: ChatMessage[], extra: ChatMessage[]): ChatMessage[] {
  return [...messages, ...extra].slice(-MAX_MESSAGES);
}

/** Items waiting on the user, newest application first. Derived from recorded events only. */
export function attentionItems(applications: Application[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const app of applications) {
    for (const requirement of pendingOf(app)) {
      items.push({
        id: `${app.id}-${requirement.id}`,
        applicationId: app.id,
        title: requirement.label,
        detail: `${requirement.kind === 'document' ? 'Document needed' : 'Information needed'} for ${app.title} ${app.id}`,
      });
    }
  }
  return items;
}
