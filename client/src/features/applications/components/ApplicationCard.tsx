import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { nextAction, progressOf, statusOf, submittedAtOf, updatedAtOf } from '@tajir/shared';
import type { Application } from '@tajir/shared';
import { StatusBadge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { ProgressBar } from '../../../components/ui/WorkflowProgress';
import { cn } from '../../../lib/cn';
import { formatDate } from '../../../lib/format';

/** Tappable summary of one application. "activity" stresses the next step, "list" shows progress. */
export function ApplicationCard({ app, variant }: { app: Application; variant: 'activity' | 'list' }) {
  const action = nextAction(app);
  const progress = progressOf(app);
  const submittedAt = submittedAtOf(app);
  return (
    <Link
      to={`/applications/${app.id}`}
      className="block rounded-card focus-visible:outline-offset-4"
      aria-label={`${app.title} ${app.id}, ${action.text}`}
    >
      <Card className="transition hover:border-brand-200">
        <div className="min-w-0">
          <p className="text-base font-semibold text-navy-900">{app.title}</p>
          <p className="mt-0.5 break-words text-xs text-muted">
            {app.id} · {app.subtitle}
          </p>
          <div className="mt-2">
            <StatusBadge status={statusOf(app)} />
          </div>
        </div>

        {variant === 'activity' ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-control bg-canvas px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                {action.needsAction ? 'Next step' : 'Status'}
              </p>
              <p className={cn('break-words text-sm', action.needsAction ? 'font-semibold text-navy-900' : 'text-ink')}>
                {action.text}
              </p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
          </div>
        ) : (
          <div className="mt-4">
            <ProgressBar progress={progress} />
            <p className="mt-1.5 text-xs text-muted">
              {progress.completedCount} of {progress.total} steps done
              {progress.current ? ` · next: ${progress.current.label}` : ''}
            </p>
          </div>
        )}

        <p className="mt-3 text-xs text-muted">
          {variant === 'list' && submittedAt ? `Submitted ${formatDate(submittedAt)} · ` : ''}
          Updated {formatDate(updatedAtOf(app))}
        </p>
      </Card>
    </Link>
  );
}
