import { Link } from 'react-router-dom';
import { nextAction, progressOf, statusOf, updatedAtOf } from '@tajir/shared';
import { StatusBadge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { ProgressBar } from '../../../components/ui/WorkflowProgress';
import { formatDate } from '../../../lib/format';
import { useApp } from '../../../state/context';
import { ApplicationCard } from '../../applications/components/ApplicationCard';
import { RequirementChecklist } from '../../applications/components/RequirementChecklist';

/** Live status card for one application (reads current data, so it updates after uploads). */
export function StatusMessageCard({ applicationId }: { applicationId: string }) {
  const { state } = useApp();
  const app = state.applications.find((a) => a.id === applicationId);
  if (!app) return null;
  const action = nextAction(app);
  const progress = progressOf(app);
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        {app.title} - {app.subtitle}
      </p>
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-navy-900">{app.id}</p>
        <StatusBadge status={statusOf(app)} />
      </div>
      <div className="mt-3">
        <ProgressBar progress={progress} />
        <p className="mt-1.5 text-xs text-muted">
          {progress.completedCount} of {progress.total} steps done
          {progress.current ? ` · next: ${progress.current.label}` : ''}
        </p>
      </div>
      <p className="mt-3 text-sm text-ink">{action.text}</p>
      <p className="mt-1 text-xs text-muted">Updated {formatDate(updatedAtOf(app))}</p>
      <Link to={`/applications/${app.id}`} className="mt-3 inline-block text-sm font-semibold text-brand-700 hover:underline">
        View details
      </Link>
    </Card>
  );
}

export function StatusListMessage({ applicationIds }: { applicationIds: string[] }) {
  const { state } = useApp();
  const apps = applicationIds
    .map((id) => state.applications.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => !!a);
  return (
    <ul className="space-y-3">
      {apps.map((app) => (
        <li key={app.id}>
          <ApplicationCard app={app} variant="activity" />
        </li>
      ))}
    </ul>
  );
}

/** Checklist with upload buttons, shown when Tajir asks for something. */
export function UploadMessageCard({ applicationId }: { applicationId: string }) {
  const { state, uploadDocument } = useApp();
  const app = state.applications.find((a) => a.id === applicationId);
  if (!app) return null;
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">
        Needed for {app.title} {app.id}
      </p>
      <div className="mt-3">
        <RequirementChecklist
          application={app}
          onUpload={(requirement, file) => uploadDocument(app.id, requirement.id, file, true)}
        />
      </div>
      <p className="mt-3 rounded-control bg-warning-50 px-3 py-2 text-[11px] text-warning-600">
        PDF, PNG or JPG, up to 10 MB. The file is checked and kept in this prototype's database, and you can open or download it again from the Documents page.
      </p>
    </Card>
  );
}
