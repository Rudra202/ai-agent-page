import { ArrowLeft, Download, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { detectedTypeLabel, documentLabel, isUnderstandingType, UNDERSTANDING_FIELDS } from '@tajir/shared';
import type { DocumentUnderstanding } from '@tajir/shared';
import { ApiError } from '../api/http';
import type { DocumentDetailView } from '../api/types';
import { DocumentPreview } from '../components/documents/DocumentPreview';
import { DocumentStatusBadges } from '../components/documents/DocumentStatusBadges';
import { useDocumentActions } from '../components/documents/useDocumentActions';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card, CardTitle } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ErrorState, LoadingState } from '../components/ui/StateViews';
import { canReprocess, isActiveStatus } from '../lib/documentStatus';
import { formatBytes, formatDate } from '../lib/format';
import { useApi, useApp } from '../state/context';

const METHOD_TEXT = {
  pdf_text: 'The text was read straight from the PDF.',
  ocr: 'The text was recognised from the image (OCR), so a few words may be wrong.',
  pdf_ocr: 'The text was recognised from scanned pages (OCR), so a few words may be wrong.',
} as const;

/** The stored reading, if it has the shape this screen knows. Anything else is not shown. */
function readingOf(value: unknown): DocumentUnderstanding | null {
  const v = value as Partial<DocumentUnderstanding> | null;
  if (!v || typeof v !== 'object' || !v.facts || typeof v.facts !== 'object' || !v.interpretation || typeof v.interpretation !== 'object') return null;
  return v as DocumentUnderstanding;
}

function ExtractedInfo({ detail }: { detail: DocumentDetailView }) {
  const extraction = detail.extraction;
  if (!extraction) {
    if (isActiveStatus(detail.processingStatus)) return <p className="text-sm text-muted">This document is being read. What is found will appear here.</p>;
    return <p className="text-sm text-muted">Nothing could be read from this document{detail.errorMessage ? `: ${detail.errorMessage}` : '.'}</p>;
  }
  const reading = readingOf(extraction.structured);
  const labels = reading && isUnderstandingType(reading.documentType) ? UNDERSTANDING_FIELDS[reading.documentType] : [];

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted">
        <p>
          {METHOD_TEXT[extraction.method]} {extraction.pageCount ? `${extraction.pageCount} page${extraction.pageCount === 1 ? '' : 's'}. ` : ''}
          It looks like a <strong className="text-navy-900">{detectedTypeLabel(extraction.detectedType)}</strong> ({extraction.confidence} confidence). This is a reading of the words, not a check that the document is genuine.
        </p>
        {extraction.truncated && <p className="mt-1">The document is very long, so only the first part was kept.</p>}
      </div>

      {reading ? (
        <>
          {labels.length > 0 && (
            <section aria-labelledby="facts-heading">
              <h3 id="facts-heading" className="mb-1.5 text-sm font-semibold text-navy-900">
                Details found in the document
              </h3>
              <p className="mb-2 text-xs text-muted">Copied from the document's own words. Blank means the document does not say.</p>
              <dl className="divide-y divide-line rounded-control border border-line">
                {labels.map((field) => {
                  const value = reading.facts[field.key];
                  const shown = Array.isArray(value) ? value.join(', ') : value;
                  return (
                    <div key={field.key} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-4">
                      <dt className="text-xs font-semibold text-muted sm:w-44 sm:shrink-0">{field.label}</dt>
                      <dd className="break-words text-sm text-ink">{shown || <span className="text-muted">Not found</span>}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          )}
          {(reading.interpretation.summary || reading.interpretation.observations.length > 0) && (
            <section aria-labelledby="ai-heading" className="rounded-control bg-canvas p-3">
              <h3 id="ai-heading" className="text-sm font-semibold text-navy-900">
                What the AI made of it
              </h3>
              <p className="mb-2 text-xs text-muted">An interpretation by an AI model. It can be wrong, so please check it against the document.</p>
              {reading.interpretation.summary && <p className="text-sm text-ink">{reading.interpretation.summary}</p>}
              {reading.interpretation.observations.length > 0 && (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink">
                  {reading.interpretation.observations.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {reading.interpretation.missingInformation.length > 0 && <p className="text-xs text-muted">Not found in the document: {reading.interpretation.missingInformation.join(', ')}.</p>}
          {reading.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
              {reading.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">{reading.disclaimer}</p>
        </>
      ) : (
        <p className="text-sm text-muted">
          {extraction.ai.status === 'skipped' || extraction.ai.status === 'not_requested'
            ? 'No AI analysis was done for this document.'
            : extraction.ai.status === 'pending'
              ? 'The AI analysis is in progress.'
              : 'The AI analysis is not available for this document. The text was still read, and you can ask Tajir about it.'}
        </p>
      )}
    </div>
  );
}

/** One page per document: moving to another document starts afresh, so nothing of the last one is shown for it. */
export function DocumentDetailPage() {
  const { id = '' } = useParams();
  return <DocumentDetail key={id} id={id} />;
}

function DocumentDetail({ id }: { id: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const { state } = useApp();
  const actions = useDocumentActions();
  const [view, setView] = useState<{ detail: DocumentDetailView | null; error: { message: string; missing: boolean } | null }>({ detail: null, error: null });
  const { detail, error } = view;
  const [confirming, setConfirming] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Nothing is set once the page has been left, for example when a slow answer arrives after the user moved on.
  const show = useCallback(
    (next: Partial<typeof view>) => {
      if (mounted.current) setView((current) => ({ ...current, ...next }));
    },
    [],
  );

  const load = useCallback(async () => {
    try {
      show({ detail: await api.documents.get(id), error: null });
    } catch (caught) {
      show({ error: { message: caught instanceof ApiError ? caught.message : 'This document could not be loaded.', missing: caught instanceof ApiError && caught.status === 404 } });
    }
  }, [api, id, show]);

  useEffect(() => {
    void load();
  }, [load]);

  // The store checks the document list every few seconds while anything is being read, and this page follows what it finds,
  // so there is one poller for the whole app and not one per screen.
  const inStore = state.documents.find((d) => d.id === id);
  const storeStatus = inStore?.processingStatus;
  useEffect(() => {
    if (detail && storeStatus && storeStatus !== detail.processingStatus) void load();
  }, [storeStatus, detail, load]);

  if (error && !detail) {
    return (
      <>
        <PageHeader title="Document" />
        <ErrorState
          title={error.missing ? 'Document not found' : 'Could not load this document'}
          message={error.missing ? 'It may have been deleted.' : error.message}
          onRetry={error.missing ? undefined : () => void load()}
          action={
            <Link to="/documents" className="inline-flex h-11 items-center rounded-control border border-line bg-surface px-5 text-sm font-semibold text-navy-900">
              Back to documents
            </Link>
          }
        />
      </>
    );
  }
  if (!detail) return <LoadingState label="Loading document..." />;

  return (
    <>
      <Link to="/documents" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-brand-600">
        <ArrowLeft className="size-4" aria-hidden /> All documents
      </Link>
      <PageHeader title={detail.originalName} subtitle={`${documentLabel(detail.typeId)} · ${formatBytes(detail.sizeBytes)} · uploaded ${formatDate(detail.createdAt)}${detail.applicationId ? ` · for ${detail.applicationId}` : ''}`} />

      {actions.error && (
        <p role="alert" className="mb-4 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-600">
          {actions.error}
        </p>
      )}

      <Card className="mb-4">
        <CardTitle>Status</CardTitle>
        <DocumentStatusBadges processingStatus={detail.processingStatus} aiStatus={detail.aiStatus} detectedType={detail.detectedType} />
        {detail.errorMessage && detail.processingStatus !== 'completed' && <p className="mt-2 break-words text-sm text-warning-600">{detail.errorMessage}</p>}
        {detail.retryCount > 0 && detail.processingStatus !== 'completed' && <p className="mt-1 text-xs text-muted">Tried {detail.retryCount + 1} time{detail.retryCount === 0 ? '' : 's'}.</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" aria-label={`Download ${detail.originalName}`} loading={actions.busy === detail.id} leadingIcon={<Download className="size-4" aria-hidden />} onClick={() => void actions.download(detail.id, detail.originalName)}>
            Download
          </Button>
          {canReprocess(detail.processingStatus) && (
            <Button size="sm" variant="secondary" disabled={actions.busy === detail.id} leadingIcon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void actions.reprocess(detail.id).then(() => load())}>
              {detail.processingStatus === 'failed' ? 'Try again' : 'Read again'}
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={`Delete ${detail.originalName}`} disabled={actions.busy === detail.id} leadingIcon={<Trash2 className="size-4" aria-hidden />} onClick={() => setConfirming(true)}>
            Delete
          </Button>
        </div>
      </Card>

      <Card className="mb-4">
        <CardTitle>Preview</CardTitle>
        <div className="mt-3">
          <DocumentPreview key={detail.id} documentId={detail.id} name={detail.originalName} mimeType={detail.mimeType} onDownload={() => void actions.download(detail.id, detail.originalName)} />
        </div>
      </Card>

      <Card>
        <CardTitle>What was read</CardTitle>
        <div className="mt-3">
          <ExtractedInfo detail={detail} />
        </div>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="Delete this document?"
        confirmLabel="Delete document"
        busy={actions.busy === detail.id}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void actions.remove(detail.id).then((ok) => (ok ? navigate('/documents', { replace: true }) : setConfirming(false)))}
      >
        <p className="text-sm text-muted">{detail.originalName} will be removed, together with everything read from it. This cannot be undone.</p>
      </ConfirmDialog>
    </>
  );
}
