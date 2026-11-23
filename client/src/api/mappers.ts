import { detailRowsOf, parseWorkflowState } from '@tajir/shared';
import type { Application, AssistantContent, WorkflowState } from '@tajir/shared';
import type { VaultDocument } from '../domain/types';
import type { ChatMessage, DocumentSource } from '../features/chat/types';
import type { ApplicationView, DocumentView, MessageView } from './types';

/**
 * The pure workflow functions in `shared` work on this shape. Status and progress are computed from its events.
 *
 * The server's `details` already include the answers the user gave to information requests, which
 * `detailRowsOf` derives from the events. The shared functions add those answers themselves, so only
 * the base rows are kept here. Keeping all of them would show every answer twice.
 */
export function toApplication(view: ApplicationView): Application {
  const answers = detailRowsOf({ id: view.id, service: view.service, title: view.title, subtitle: view.subtitle, details: [], events: view.events }).length;
  const base = view.details.slice(0, Math.max(0, view.details.length - answers));
  return { id: view.id, service: view.service, title: view.title, subtitle: view.subtitle, details: base, events: view.events };
}

export function toVaultDocument(view: DocumentView): VaultDocument {
  return {
    id: view.id,
    typeId: view.typeId,
    name: view.originalName,
    sizeBytes: view.sizeBytes,
    uploadedAt: view.createdAt,
    applicationId: view.applicationId,
    stored: true,
    mimeType: view.mimeType,
    processingStatus: view.processingStatus,
    aiStatus: view.aiStatus,
    detectedType: view.detectedType,
    errorMessage: view.errorMessage,
  };
}

/** The documents an answer came from. Anything that is not a well-formed source is ignored. */
function sourcesOf(payload: unknown): DocumentSource[] {
  const list = (payload as { sources?: unknown } | null)?.sources;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): DocumentSource[] => {
    const s = item as { documentId?: unknown; name?: unknown; page?: unknown };
    if (typeof s?.documentId !== 'string' || typeof s.name !== 'string') return [];
    return [{ documentId: s.documentId, name: s.name, ...(typeof s.page === 'number' ? { page: s.page } : {}) }];
  });
}

const CARD_KINDS = new Set(['options', 'summary', 'status', 'status_list', 'upload']);

/** Rebuilds a chat message. Cards keep their fields in the payload. Anything unrecognised is dropped. */
export function toChatMessage(view: MessageView): ChatMessage | null {
  if (view.role === 'user') {
    return { id: view.id, at: view.createdAt, role: 'user', kind: 'text', text: view.text ?? '' };
  }
  if (view.kind === 'text') {
    const sources = sourcesOf(view.payload);
    return { id: view.id, at: view.createdAt, role: 'assistant', kind: 'text', text: view.text ?? '', ...(sources.length ? { sources } : {}) };
  }
  if (view.kind === 'document') {
    const p = view.payload as { documentId?: unknown; name?: unknown; typeLabel?: unknown; status?: unknown } | null;
    if (p && typeof p.documentId === 'string' && typeof p.name === 'string') {
      return { id: view.id, at: view.createdAt, role: 'assistant', kind: 'document', documentId: p.documentId, name: p.name, typeLabel: typeof p.typeLabel === 'string' ? p.typeLabel : 'Document', status: typeof p.status === 'string' ? p.status : 'queued' };
    }
    return null;
  }
  if (CARD_KINDS.has(view.kind) && view.payload && typeof view.payload === 'object') {
    return { id: view.id, at: view.createdAt, role: 'assistant', ...({ kind: view.kind, ...(view.payload as object) } as AssistantContent) };
  }
  return null;
}

export function toChatMessages(views: MessageView[]): ChatMessage[] {
  return views.map(toChatMessage).filter((m): m is ChatMessage => m !== null);
}

/** The server validates the workflow, and it is checked again here, so a bad value can never reach the screens. */
export function toWorkflow(value: unknown): WorkflowState {
  return parseWorkflowState(value);
}

/** The reference of an application that a chat turn created, read from the status card the engine adds. */
export function createdApplicationOf(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role === 'assistant' && message.kind === 'status') return message.applicationId;
  }
  return undefined;
}
