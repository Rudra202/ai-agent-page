import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DocumentStatusBadges } from '../../../components/documents/DocumentStatusBadges';
import { Card } from '../../../components/ui/Card';
import type { DocumentProcessingStatus } from '../../../api/types';
import { useApp } from '../../../state/context';
import type { DocumentSource } from '../types';

const KNOWN: DocumentProcessingStatus[] = ['uploaded', 'queued', 'processing', 'retrying', 'completed', 'partially_completed', 'failed'];

/**
 * A document attached in the chat, with how far its reading has got. Its state comes from the same list the
 * Documents page shows, so it updates by itself as the document is read.
 */
export function DocumentMessageCard({ documentId, name, typeLabel, status }: { documentId: string; name: string; typeLabel: string; status: string }) {
  const { state } = useApp();
  const current = state.documents.find((d) => d.id === documentId);
  const shown: DocumentProcessingStatus = current?.processingStatus ?? (KNOWN.includes(status as DocumentProcessingStatus) ? (status as DocumentProcessingStatus) : 'queued');

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">
          <FileText className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {current ? (
            <Link to={`/documents/${documentId}`} className="block break-words text-sm font-semibold text-navy-900 hover:underline">
              {name}
            </Link>
          ) : (
            // Deleted since: nothing to open.
            <p className="break-words text-sm font-semibold text-navy-900">{name}</p>
          )}
          <p className="text-xs text-muted">{typeLabel}</p>
          {current ? (
            <DocumentStatusBadges processingStatus={shown} aiStatus={current.aiStatus} detectedType={current.detectedType} />
          ) : (
            <p className="mt-1.5 text-xs text-muted">This document has been deleted.</p>
          )}
          {current?.errorMessage && (shown === 'failed' || shown === 'partially_completed') && <p className="mt-1.5 break-words text-xs text-warning-600">{current.errorMessage}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Which of the user's documents an answer came from, each one a link to that document. */
export function DocumentSources({ sources }: { sources: DocumentSource[] }) {
  if (sources.length === 0) return null;
  return (
    <p className="mt-1.5 px-1 text-xs text-muted" data-testid="answer-sources">
      From:{' '}
      {sources.map((source, index) => (
        <span key={`${source.documentId}-${source.page ?? ''}`}>
          {index > 0 && ', '}
          <Link to={`/documents/${source.documentId}`} className="font-semibold text-brand-600 underline">
            {source.name}
          </Link>
          {source.page ? ` (page ${source.page})` : ''}
        </span>
      ))}
    </p>
  );
}
