import { ArrowLeft, FlaskConical, MessageCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { detailRowsOf, nextExternalStep, pendingOf, progressOf, statusOf, submittedAtOf, updatedAtOf } from '@tajir/shared';
import { StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardTitle } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { SuccessNote } from '../components/ui/StateViews';
import { ProgressBar, ProgressSteps } from '../components/ui/WorkflowProgress';
import { RequirementChecklist } from '../features/applications/components/RequirementChecklist';
import { Timeline } from '../features/applications/components/Timeline';
import { formatDate } from '../lib/format';
import { useApp } from '../state/context';

export function ApplicationDetailPage() {
  const { id } = useParams();
  const { state, continueInChat, uploadDocument, simulateNextStep, refresh } = useApp();
  const navigate = useNavigate();
  const location = useLocation() as { state: { justSubmitted?: boolean } | null };
  const [simulationMessage, setSimulationMessage] = useState<string | null>(null);
  const [simulating, setSimulating] = useState(false);
  const app = state.applications.find((a) => a.id === id);

  // Status comes from the server's event log, so the page asks for the latest whenever it is opened.
  useEffect(() => {
    void refresh();
  }, [id, refresh]);

  if (!app) {
    return (
      <EmptyState
        title="Application not found"
        description="We could not find that application. It may have been removed."
        action={
          <Link to="/applications" className="text-sm font-semibold text-brand-700 hover:underline">
            Back to applications
          </Link>
        }
      />
    );
  }

  const pending = pendingOf(app);
  const first = pending[0];
  const progress = progressOf(app);
  const submittedAt = submittedAtOf(app);
  const simulatable = nextExternalStep(app.service, app.events);

  return (
    <div className="space-y-4">
      <div>
        {location.state?.justSubmitted && (
          <div className="mb-3">
            <SuccessNote>Submitted. Your request is recorded in this prototype and you can follow every step here. Nothing is filed with any authority.</SuccessNote>
          </div>
        )}
        <Link to="/activity" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-navy-900">
          <ArrowLeft className="size-4" aria-hidden />
          <span className="sr-only">Back to activity: </span>
          {app.id}
        </Link>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight text-navy-900">{app.title}</h1>
            <p className="mt-1 text-sm text-muted">{app.subtitle}</p>
          </div>
          <StatusBadge status={statusOf(app)} />
        </div>
      </div>

      {first && (
        <section aria-label="Action required" className="rounded-card border border-warning-600/30 bg-warning-50 p-4">
          <p className="text-sm font-semibold text-warning-600">Action required</p>
          <p className="mt-1 text-sm text-navy-900">
            {pending.length === 1 ? first.label : `${pending.length} items are needed, starting with ${first.label.toLowerCase()}`}
          </p>
          <Button
            fullWidth
            className="mt-3"
            leadingIcon={<MessageCircle className="size-4" aria-hidden />}
            onClick={() => {
              void continueInChat(app.id);
              navigate('/chat');
            }}
          >
            Continue in chat
          </Button>
        </section>
      )}

      <Card>
        <CardTitle>Progress</CardTitle>
        <div className="mt-3">
          <ProgressBar progress={progress} />
          <p className="mt-1.5 text-xs text-muted">
            {progress.completedCount} of {progress.total} steps done. A step is only marked done once it has happened.
          </p>
        </div>
        <div className="mt-4">
          <ProgressSteps progress={progress} />
        </div>
      </Card>

      <Card>
        <CardTitle>What we need from you</CardTitle>
        <div className="mt-3">
          <RequirementChecklist
            application={app}
            onUpload={(requirement, file) => uploadDocument(app.id, requirement.id, file)}
          />
        </div>
        <p className="mt-3 text-[11px] text-muted">
          Uploaded files are checked and kept in this prototype's database, and you can open or download them again from the Documents page.
        </p>
      </Card>

      <Card>
        <CardTitle>Details</CardTitle>
        <dl className="mt-3 divide-y divide-line text-sm">
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Application ID</dt>
            <dd className="font-medium text-navy-900">{app.id}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Service</dt>
            <dd className="font-medium text-navy-900">{app.title}</dd>
          </div>
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Submission date</dt>
            <dd className="text-right font-medium text-navy-900">
              {submittedAt
                ? formatDate(submittedAt)
                : app.service === 'working_capital_finance'
                  ? 'Not applicable: the prototype records the request only'
                  : 'Not submitted yet'}
            </dd>
          </div>
          {detailRowsOf(app).map((row) => (
            <div key={row.label} className="flex justify-between gap-4 py-2">
              <dt className="shrink-0 text-muted">{row.label}</dt>
              <dd className="text-right font-medium text-navy-900">{row.value}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-4 py-2">
            <dt className="text-muted">Last updated</dt>
            <dd className="font-medium text-navy-900">{formatDate(updatedAtOf(app))}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardTitle>Timeline</CardTitle>
        <div className="mt-3">
          <Timeline events={app.events} />
        </div>
      </Card>

      {simulatable && (
        <section aria-label="Prototype controls" className="rounded-card border border-dashed border-warning-600/50 bg-surface p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-warning-600">
            <FlaskConical className="size-4" aria-hidden />
            Prototype only
          </p>
          <p className="mt-1 text-sm text-muted">
            No authority or provider is connected, so the later steps cannot happen for real. You can record the next one as a
            simulation to test the flow. It is labelled Simulated everywhere.
          </p>
          <Button
            className="mt-3"
            variant="secondary"
            loading={simulating}
            onClick={async () => {
              setSimulating(true);
              const outcome = await simulateNextStep(app.id);
              setSimulating(false);
              setSimulationMessage(outcome.ok ? `Recorded "${outcome.label}" as simulated.` : (outcome.error ?? null));
            }}
          >
            Simulate: {simulatable.label}
          </Button>
        </section>
      )}
      {simulationMessage && (
        <p role="status" className="text-center text-xs text-muted">
          {simulationMessage}
        </p>
      )}
    </div>
  );
}
