import type { ApplicationStatus, DetailRow, WorkflowEvent, WorkflowType } from '@tajir/shared';
import type { AiStatus, DocumentStatus } from './documents.js';

/** Plain data shapes used by the services. They know nothing about MongoDB. */

export interface User {
  id: string;
  name: string;
  /** Always lower case. */
  email: string;
  createdAt: Date;
}

export interface UserWithSecret extends User {
  passwordHash: string;
}

export type BusinessProfileKind = 'existing_company' | 'new_company';

export interface BusinessProfile {
  id: string;
  userId: string;
  kind: BusinessProfileKind;
  name: string;
  registrationType?: string;
  jurisdictionId?: string;
  packageId?: string;
  activity?: string;
  category?: string;
  description?: string;
  shareholders?: number;
  createdAt: Date;
}

export interface ServiceStep {
  kind: string;
  label: string;
}

export interface ServiceRecord {
  id: string;
  slug: WorkflowType;
  type: WorkflowType;
  name: string;
  description: string;
  steps: ServiceStep[];
  /** Sample configuration (jurisdictions, packages, document rules...). */
  config: Record<string, unknown>;
  /** True while the configuration is prototype data and not verified real information. */
  sample: boolean;
}

export interface ConversationRecord {
  id: string;
  userId: string;
  title: string;
  /** Workflow state owned by the backend. The AI never writes it directly. */
  workflow: Record<string, unknown>;
  /** Suggested replies shown under the latest assistant message. Chosen by the backend. */
  quickReplies: string[];
  status: 'active' | 'archived';
  lastMessageAt: Date;
  createdAt: Date;
}

export const MESSAGE_KINDS = ['text', 'options', 'summary', 'status', 'status_list', 'upload', 'document'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MessageRecord {
  id: string;
  conversationId: string;
  userId: string;
  role: 'user' | 'assistant';
  kind: MessageKind;
  text?: string;
  /** Structured card content for non-text kinds. */
  payload?: unknown;
  createdAt: Date;
}

/**
 * Identity and cached lookup fields only. Status, progress and requirements are
 * derived from the application's events and are never trusted from this record.
 */
export interface ApplicationRecord {
  id: string;
  userId: string;
  /** Human-readable reference such as REG-2026-178295. Unique. */
  reference: string;
  service: WorkflowType;
  serviceId?: string;
  title: string;
  subtitle: string;
  details: DetailRow[];
  businessProfileId?: string;
  /** Cache of the status derived from events, kept for filtering and indexing. */
  status: ApplicationStatus;
  lastEventAt: Date;
  createdAt: Date;
}

export interface DocumentRecord {
  id: string;
  userId: string;
  /** The business profile it belongs to, when there is one. */
  businessProfileId?: string;
  /** Reference of the application it was uploaded for, when there is one. */
  applicationId?: string;
  requirementId?: string;
  typeId: string;
  /** Sanitised display name only. Never used to build a file path. */
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Reference inside the storage provider: the GridFS file id, or the key of an older file on local disk. */
  storageKey: string;
  storageProvider: string;
  /** Set when a migration moved the file: where it was before, so the move can be undone while that copy still exists. */
  previousStorage?: { provider: string; key: string };
  /** Where processing has got to. Documents saved before processing existed start as "uploaded". */
  processingStatus: DocumentStatus;
  aiStatus: AiStatus;
  /** What the document looks like to the reader (a trade licence, a passport...). Never changes the category chosen by the user. */
  detectedType?: string;
  /** A short reason for the last failure that is safe to show. Never a stack trace and never file content. */
  errorMessage?: string;
  retryCount: number;
  processedAt?: Date;
  /** Set the moment the user deletes it. From then on it cannot be read, while the file and extraction are removed. */
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type EventWithOwner = { applicationId: string; userId: string; event: WorkflowEvent };

/** The natural, unique key of an event: a milestone once, a requirement requested once, provided once. */
export function eventUniqueKey(event: Pick<WorkflowEvent, 'kind' | 'requirement' | 'requirementId'>): string {
  if (event.kind === 'requirement_requested') return `rq:${event.requirement?.id ?? ''}`;
  if (event.kind === 'requirement_provided') return `rp:${event.requirementId ?? ''}`;
  return `m:${event.kind}`;
}
