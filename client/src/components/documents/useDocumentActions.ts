import { useCallback, useState } from 'react';
import { ApiError } from '../../api/http';
import { saveBlob } from '../../lib/download';
import { useApi, useApp } from '../../state/context';

/**
 * What the user can do with one of their documents: download it, read it again, delete it. Each says plainly when it
 * could not be done, and nothing is changed on screen until the server has answered.
 */
export function useDocumentActions() {
  const api = useApi();
  const { removeDocument, reprocessDocument } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async (id: string, task: () => Promise<{ ok: boolean; error?: string } | void>): Promise<boolean> => {
    setBusy(id);
    setError(null);
    try {
      const outcome = await task();
      if (outcome && !outcome.ok) {
        setError(outcome.error ?? 'That did not work. Please try again.');
        return false;
      }
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work. Please try again.');
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    error,
    busy,
    clearError: () => setError(null),
    download: (id: string, name: string) =>
      run(id, async () => {
        saveBlob(await api.documents.file(id, 'download'), name);
      }),
    reprocess: (id: string) => run(id, () => reprocessDocument(id)),
    remove: (id: string) => run(id, () => removeDocument(id)),
  };
}
