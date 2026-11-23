import { ArrowUp, FolderOpen, Mic, Paperclip } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { pendingOf } from '@tajir/shared';
import { PROCESSING_LABEL } from '../../../lib/documentStatus';
import { ACCEPT_ATTRIBUTE } from '../../../lib/files';
import { useApp } from '../../../state/context';

/** The "Ask Tajir..." input with attach and send. Used on Home and in Chat. */
export function Composer({ onSend, disabled = false }: { onSend: (text: string) => void; disabled?: boolean }) {
  const { state, uploadDocument, attachInChat, attachExisting } = useApp();
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  // The paperclip attaches to the application Tajir is currently helping with, else the first one waiting on a document.
  const preferred = state.applications.find((a) => a.id === state.workflow.clarificationApplicationId);
  const candidates = [...(preferred ? [preferred] : []), ...state.applications];
  const target = candidates
    .map((app) => ({ app, requirement: pendingOf(app).find((r) => r.kind === 'document') }))
    .find((t) => t.requirement);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    setError(null);
    onSend(text);
  };

  const hasText = value.trim().length > 0;

  return (
    <div>
      {error && (
        <p id={errorId} role="alert" className="mb-1.5 px-2 text-xs text-danger-600">
          {error}
        </p>
      )}
      {uploading && (
        <p role="status" className="mb-1.5 px-2 text-xs text-muted">
          Uploading your document...
        </p>
      )}
      {picking && (
        <div role="group" aria-label="Your documents" className="mb-2 max-h-56 overflow-y-auto rounded-card border border-line bg-surface p-2 shadow-card">
          {state.documents.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted">You have no documents yet. Use the paperclip to attach one.</p>
          ) : (
            <ul>
              {state.documents.slice(0, 20).map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    aria-label={`Use ${doc.name}`}
                    disabled={uploading}
                    onClick={() => {
                      setPicking(false);
                      setError(null);
                      setUploading(true);
                      void attachExisting(doc.id)
                        .then((outcome) => setError(outcome.ok ? null : (outcome.error ?? 'Could not attach that document.')))
                        .catch(() => setError('Could not attach that document. Please try again.'))
                        .finally(() => setUploading(false));
                    }}
                    className="flex w-full items-center justify-between gap-3 rounded-control px-2 py-2 text-left text-sm hover:bg-canvas disabled:opacity-50"
                  >
                    <span className="min-w-0 break-words text-ink">{doc.name}</span>
                    <span className="shrink-0 text-xs text-muted">{PROCESSING_LABEL[doc.processingStatus]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <form
        onSubmit={submit}
        className="flex items-center gap-1 rounded-full border border-line bg-surface py-1.5 pl-2 pr-1.5 shadow-card"
      >
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          className="sr-only"
          tabIndex={-1}
          aria-label="Attach a document"
          data-testid="composer-file-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setUploading(true);
            setError(null);
            // A document an application is waiting for goes to that application. Any other file is attached to the chat,
            // where Tajir reads it and can then be asked about it.
            const sent = target?.requirement ? uploadDocument(target.app.id, target.requirement.id, file, true) : attachInChat(file);
            void sent
              .then((outcome) => setError(outcome.ok ? null : (outcome.error ?? 'Upload failed.')))
              .catch(() => setError('Upload failed. Please try again.'))
              .finally(() => setUploading(false));
          }}
        />
        <button
          type="button"
          aria-label={target ? `Attach ${target.requirement?.label}` : 'Attach a document'}
          title={target ? `Attach ${target.requirement?.label}` : 'Attach a document for Tajir to read'}
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-canvas disabled:opacity-40"
        >
          <Paperclip className="size-5" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Choose an existing document"
          aria-expanded={picking}
          title="Use a document you have already uploaded"
          disabled={uploading}
          onClick={() => setPicking((open) => !open)}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-canvas disabled:opacity-40"
        >
          <FolderOpen className="size-5" aria-hidden />
        </button>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Ask Tajir..."
          aria-label="Message Tajir"
          aria-describedby={error ? errorId : undefined}
          maxLength={500}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm text-ink outline-none placeholder:text-muted"
        />
        {hasText ? (
          <button
            type="submit"
            aria-label="Send message"
            disabled={disabled}
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-navy-900 text-white disabled:opacity-50"
          >
            <ArrowUp className="size-5" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            disabled
            aria-label="Voice input is not available in the prototype"
            title="Voice input is not available in the prototype"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-navy-900 text-white opacity-40"
          >
            <Mic className="size-5" aria-hidden />
          </button>
        )}
      </form>
    </div>
  );
}
