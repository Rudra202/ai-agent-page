import { Check, Circle } from 'lucide-react';
import { requirementsOfApp } from '@tajir/shared';
import type { Application, Requirement } from '@tajir/shared';
import { UploadButton } from '../../../components/ui/UploadButton';
import type { UploadCheck } from '../../../lib/files';

/**
 * Missing-information checklist. Documents get an upload button, information is
 * answered in chat. "Recorded" means the step is on the application's event log.
 */
export function RequirementChecklist({
  application,
  onUpload,
}: {
  application: Application;
  onUpload: (requirement: Requirement, file: File) => Promise<UploadCheck>;
}) {
  const requirements = requirementsOfApp(application);
  if (requirements.length === 0) {
    return <p className="text-sm text-muted">Nothing is needed from you for this application.</p>;
  }
  return (
    <ul className="divide-y divide-line">
      {requirements.map((requirement) => (
        <li key={requirement.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <span className="flex min-w-0 items-center gap-2.5 text-sm">
            {requirement.done ? (
              <Check className="size-5 shrink-0 text-success-600" aria-hidden />
            ) : (
              <Circle className="size-5 shrink-0 text-warning-600" aria-hidden />
            )}
            <span className={requirement.done ? 'text-muted' : 'font-medium text-navy-900'}>
              {requirement.label}
              <span className="sr-only">{requirement.done ? ' (recorded)' : ' (needed)'}</span>
            </span>
          </span>
          {requirement.done ? (
            <span className="shrink-0 text-xs font-medium text-success-600">Recorded</span>
          ) : requirement.kind === 'document' ? (
            <UploadButton ariaLabel={`Upload ${requirement.label}`} onFile={(file) => onUpload(requirement, file)} />
          ) : (
            <span className="shrink-0 text-xs text-muted">Reply in chat</span>
          )}
        </li>
      ))}
    </ul>
  );
}
