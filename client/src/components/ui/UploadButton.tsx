import { Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ACCEPT_ATTRIBUTE } from '../../lib/files';
import type { UploadCheck } from '../../lib/files';
import { Button } from './Button';

/**
 * Button that opens a file picker, sends the choice and reports the outcome inline:
 * busy while the file is on its way, the reason if it was refused, "Uploaded" if it worked.
 */
export function UploadButton({
  label = 'Upload',
  ariaLabel,
  onFile,
  disabled,
}: {
  label?: string;
  ariaLabel?: string;
  onFile: (file: File) => Promise<UploadCheck> | UploadCheck;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const errorId = useId();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handle = async (file: File) => {
    setBusy(true);
    setError(null);
    setDone(null);
    let outcome: UploadCheck;
    try {
      outcome = await onFile(file);
    } catch {
      outcome = { ok: false, error: 'Upload failed. Please try again.' };
    }
    if (!mounted.current) return;
    setBusy(false);
    if (outcome.ok) setDone(`${file.name} uploaded`);
    else setError(outcome.error ?? 'Upload failed.');
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        tabIndex={-1}
        aria-label={ariaLabel ? `${ariaLabel} file` : 'Choose file'}
        data-testid="file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void handle(file);
        }}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={disabled}
        loading={busy}
        leadingIcon={<Upload className="size-4" aria-hidden />}
        aria-label={ariaLabel}
        aria-describedby={error ? errorId : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading...' : label}
      </Button>
      {error && (
        <p id={errorId} role="alert" className="max-w-56 text-right text-xs text-danger-600">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="max-w-56 break-words text-right text-xs text-success-600">
          {done}
        </p>
      )}
    </div>
  );
}
