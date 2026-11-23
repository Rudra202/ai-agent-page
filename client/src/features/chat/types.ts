import type { AssistantContent } from '@tajir/shared';

export type { AssistantContent, ChatUser, OptionCard, SummaryField, WorkflowState } from '@tajir/shared';
export { DEFAULT_QUICK_REPLIES, INITIAL_WORKFLOW } from '@tajir/shared';

interface MessageBase {
  id: string;
  at: string;
}

/** Where an answer about the user's documents came from. */
export interface DocumentSource {
  documentId: string;
  name: string;
  page?: number;
}

export type UserMessage = MessageBase & { role: 'user'; kind: 'text'; text: string };
/** The assistant's words. An answer about the user's documents also names the documents it came from. */
export type AssistantMessage = MessageBase & { role: 'assistant' } & AssistantContent & { sources?: DocumentSource[] };
/** A document the user attached in the chat, shown with how far its reading has got. */
export type DocumentCardMessage = MessageBase & { role: 'assistant'; kind: 'document'; documentId: string; name: string; typeLabel: string; status: string };
export type ChatMessage = UserMessage | AssistantMessage | DocumentCardMessage;
