import { Download, FileText, Info, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCUMENT_TYPES, documentLabel, pendingOf } from '@tajir/shared';
import { DocumentStatusBadges } from '../components/documents/DocumentStatusBadges';
import { useDocumentActions } from '../components/documents/useDocumentActions';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card, CardDescription, CardTitle } from '../components/ui/Card';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { EmptyState } from '../components/ui/EmptyState';
import { Field, inputClass } from '../components/ui/Field';
import { UploadButton } from '../components/ui/UploadButton';
import type { VaultDocument } from '../domain/types';
import { canReprocess } from '../lib/documentStatus';
import { formatBytes, formatDate } from '../lib/format';
import { useApp } from '../state/context';

export function DocumentsPage() {
  const { state, uploadDocument, addVaultDocument } = useApp();
  const actions = useDocumentActions();
  const [typeId, setTypeId] = useState('');
  const [typeError, setTypeError] = useState<string | undefined>();
  const [toDelete, setToDelete] = useState<VaultDocument | null>(null);

  const needed = state.applications.flatMap((app) =>
    pendingOf(app)
      .filter((r) => r.kind === 'document')
      .map((requirement) => ({ app, requirement })),
  );

  return (
    <>
      <PageHeader title="Documents" subtitle="Your document records and anything Tajir is waiting for." />

      <div role="note" className="mb-6 flex gap-2 rounded-card bg-warning-50 p-4 text-sm text-warning-600">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <p>
          <strong>Stored in this prototype's database.</strong> Files you upload are checked and kept in the prototype's MongoDB database,
          not in cloud storage. Tajir reads each one so you can ask about it in the chat. You can open, download, read again or delete a document here.
        </p>
      </div>

      {actions.error && (
        <p role="alert" className="mb-4 rounded-control bg-danger-50 px-3 py-2 text-sm text-danger-600">
          {actions.error}
        </p>
      )}

      {needed.length > 0 && (
        <section aria-labelledby="needed-heading" className="mb-6">
          <h2 id="needed-heading" className="mb-2 text-[11px] font-semibold tracking-wider text-muted">
            NEEDED NOW
          </h2>
          <ul className="space-y-3">
            {needed.map(({ app, requirement }) => (
              <li key={`${app.id}-${requirement.id}`}>
                <Card className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-navy-900">{requirement.label}</p>
                    <p className="mt-0.5 break-words text-xs text-muted">
                      For {app.title} {app.id}
                    </p>
                  </div>
                  <UploadButton
                    ariaLabel={`Upload ${requirement.label} for ${app.id}`}
                    onFile={(file) => uploadDocument(app.id, requirement.id, file)}
                  />
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="vault-heading">
        <h2 id="vault-heading" className="mb-2 text-[11px] font-semibold tracking-wider text-muted">
          YOUR DOCUMENTS
        </h2>
        {state.documents.length === 0 ? (
          <EmptyState icon={<FileText className="size-6" aria-hidden />} title="No documents yet" description="Upload one below, or when Tajir asks for it." />
        ) : (
          <ul className="space-y-3">
            {state.documents.map((doc) => (
              <li key={doc.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-brand-50 text-brand-600">
                      <FileText className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <Link to={`/documents/${doc.id}`} aria-label={`Details for ${doc.name}`} className="block break-words text-sm font-semibold text-navy-900 hover:underline">
                        {documentLabel(doc.typeId)}
                      </Link>
                      <p className="break-words text-xs text-muted">
                        {doc.name} · {formatBytes(doc.sizeBytes)} · {formatDate(doc.uploadedAt)}
                        {doc.applicationId ? ` · for ${doc.applicationId}` : ''}
                      </p>
                      <DocumentStatusBadges processingStatus={doc.processingStatus} aiStatus={doc.aiStatus} detectedType={doc.detectedType} />
                      {doc.errorMessage && (doc.processingStatus === 'failed' || doc.processingStatus === 'partially_completed' || doc.processingStatus === 'retrying') && (
                        <p className="mt-1.5 break-words text-xs text-warning-600">{doc.errorMessage}</p>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="secondary" aria-label={`Download ${doc.name}`} loading={actions.busy === doc.id} leadingIcon={<Download className="size-4" aria-hidden />} onClick={() => void actions.download(doc.id, doc.name)}>
                      Download
                    </Button>
                    {canReprocess(doc.processingStatus) && (
                      <Button size="sm" variant="secondary" aria-label={`Read ${doc.name} again`} disabled={actions.busy === doc.id} leadingIcon={<RefreshCw className="size-4" aria-hidden />} onClick={() => void actions.reprocess(doc.id)}>
                        {doc.processingStatus === 'failed' ? 'Try again' : 'Read again'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" aria-label={`Delete ${doc.name}`} disabled={actions.busy === doc.id} leadingIcon={<Trash2 className="size-4" aria-hidden />} onClick={() => setToDelete(doc)}>
                      Delete
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card className="mt-6">
        <CardTitle>Upload a document</CardTitle>
        <CardDescription>PDF, PNG or JPG, up to 10 MB. The file is checked by its content before it is stored, then read so you can ask about it.</CardDescription>
        <div className="mt-4 space-y-3">
          <Field label="Document type" error={typeError}>
            {(props) => (
              <select
                {...props}
                className={inputClass}
                value={typeId}
                onChange={(event) => {
                  setTypeId(event.target.value);
                  setTypeError(undefined);
                }}
              >
                <option value="">Select a type</option>
                {Object.entries(DOCUMENT_TYPES).map(([id, type]) => (
                  <option key={id} value={id}>
                    {type.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="flex justify-end">
            <UploadButton
              label="Choose file"
              ariaLabel="Add document"
              onFile={async (file) => {
                if (!typeId) {
                  setTypeError('Choose a document type first.');
                  return { ok: false, error: 'Choose a document type first.' };
                }
                return addVaultDocument(typeId, file);
              }}
            />
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this document?"
        confirmLabel="Delete document"
        busy={toDelete !== null && actions.busy === toDelete.id}
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          const doc = toDelete;
          if (!doc) return;
          void actions.remove(doc.id).then(() => setToDelete(null));
        }}
      >
        <p className="text-sm text-muted">
          {toDelete ? `${toDelete.name} will be removed, together with everything read from it. ` : ''}This cannot be undone. An application that already recorded it keeps its history.
        </p>
      </ConfirmDialog>
    </>
  );
}
