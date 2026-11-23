import { Download, FileWarning } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/http';
import { useApi } from '../../state/context';
import { Button } from '../ui/Button';
import { LoadingState } from '../ui/StateViews';

type Phase = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; message: string };

/**
 * Shows a stored PDF or image. The file is fetched from the server with the user's session and shown from a temporary
 * address in the browser that is dropped when the preview closes, so it is never kept anywhere. If it cannot be
 * shown, the reason is given and the file can still be downloaded. Show a different document with a different `key`.
 */
export function DocumentPreview({ documentId, name, mimeType, onDownload }: { documentId: string; name: string; mimeType: string; onDownload: () => void }) {
  const api = useApi();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    api.documents
      .file(documentId, 'view')
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPhase({ kind: 'ready', url: objectUrl });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({ kind: 'error', message: error instanceof ApiError ? error.message : 'The preview could not be loaded.' });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, documentId, attempt]);

  if (phase.kind === 'loading') return <LoadingState label="Loading preview..." />;

  if (phase.kind === 'error') {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 rounded-card border border-line bg-canvas px-6 py-8 text-center">
        <FileWarning className="size-6 text-warning-600" aria-hidden />
        <p className="text-sm font-semibold text-navy-900">The preview is not available</p>
        <p className="max-w-sm text-sm text-muted">{phase.message}</p>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setPhase({ kind: 'loading' });
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </Button>
          <Button size="sm" variant="secondary" leadingIcon={<Download className="size-4" aria-hidden />} onClick={onDownload}>
            Download instead
          </Button>
        </div>
      </div>
    );
  }

  const isPdf = mimeType === 'application/pdf';
  return (
    <div>
      {isPdf ? (
        <iframe title={`Preview of ${name}`} src={phase.url} className="h-[70vh] w-full rounded-card border border-line bg-surface" />
      ) : (
        <img src={phase.url} alt={`Preview of ${name}`} className="mx-auto max-h-[70vh] max-w-full rounded-card border border-line bg-surface object-contain" />
      )}
      <p className="mt-2 text-xs text-muted">
        Cannot see it?{' '}
        <button type="button" onClick={onDownload} className="font-semibold text-brand-600 underline">
          Download the file
        </button>
        .
      </p>
    </div>
  );
}
