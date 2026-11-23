import type { DocumentAiStatus, DocumentProcessingStatus } from '../api/types';

/**
 * A document the user has uploaded. The file itself is stored by the server (in MongoDB GridFS; this
 * prototype has no cloud storage), and the browser holds only its details. The file is fetched from the
 * server when it is previewed or downloaded, and is never kept in the browser.
 */
export interface VaultDocument {
  id: string;
  typeId: string;
  /** File name as chosen by the user, cleaned by the server. */
  name: string;
  sizeBytes: number;
  uploadedAt: string;
  /** Reference of the application the document was uploaded for, if any. */
  applicationId: string | null;
  /** True when the server holds the file. */
  stored: true;
  mimeType: string;
  processingStatus: DocumentProcessingStatus;
  aiStatus: DocumentAiStatus;
  /** What the content looks like, as read by the system. Not a verification. */
  detectedType: string | null;
  /** A short reason, when reading failed or only partly worked. */
  errorMessage: string | null;
}

export interface UserProfile {
  name: string;
  firstName: string;
  email: string;
  /** The company named at sign-up. Empty when none was given. */
  company: string;
}

/** Something that needs the user's attention, worked out from the real state of their applications. */
export interface AttentionItem {
  id: string;
  applicationId: string;
  title: string;
  detail: string;
}
