import type { DocumentAiStatus, DocumentProcessingStatus } from '../api/types';

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export const PROCESSING_LABEL: Record<DocumentProcessingStatus, string> = {
  uploaded: 'Uploaded',
  queued: 'Waiting to be read',
  processing: 'Reading...',
  retrying: 'Trying again',
  completed: 'Read',
  partially_completed: 'Partly read',
  failed: 'Could not be read',
};

export const PROCESSING_TONE: Record<DocumentProcessingStatus, StatusTone> = {
  uploaded: 'neutral',
  queued: 'neutral',
  processing: 'info',
  retrying: 'warning',
  completed: 'success',
  partially_completed: 'warning',
  failed: 'danger',
};

/** The AI step is optional, so "not requested" shows nothing at all. */
export const AI_LABEL: Partial<Record<DocumentAiStatus, string>> = {
  pending: 'AI reading...',
  completed: 'AI details ready',
  skipped: 'AI not used',
  unavailable: 'AI unavailable',
  failed: 'AI analysis failed',
};

export const AI_TONE: Record<DocumentAiStatus, StatusTone> = {
  not_requested: 'neutral',
  pending: 'info',
  completed: 'success',
  skipped: 'neutral',
  unavailable: 'warning',
  failed: 'warning',
};

/** Still being worked on, so a screen keeps checking. */
export const isActiveStatus = (status: DocumentProcessingStatus): boolean => status === 'uploaded' || status === 'queued' || status === 'processing' || status === 'retrying';

/** A document can be read again once it is not already waiting or running. */
export const canReprocess = (status: DocumentProcessingStatus): boolean => status === 'completed' || status === 'partially_completed' || status === 'failed';
