import { Check } from 'lucide-react';
import type { ApplicationProgress } from '@tajir/shared';
import { cn } from '../../lib/cn';
import { formatDate } from '../../lib/format';

/** Progress bar. The fraction is completed steps divided by total steps for this service. */
export function ProgressBar({ progress }: { progress: ApplicationProgress }) {
  const percent = Math.round(progress.fraction * 100);
  const where = progress.current ? `next: ${progress.current.label}` : 'all steps done';
  return (
    <div
      role="progressbar"
      aria-label="Application progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${progress.completedCount} of ${progress.total} steps done, ${where}`}
      className="h-2 w-full overflow-hidden rounded-full bg-brand-100"
    >
      <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${percent}%` }} />
    </div>
  );
}

/**
 * The steps of this service. A step shows as done only if the matching event
 * was recorded, and shows the date it happened. Simulated steps are labelled.
 */
export function ProgressSteps({ progress }: { progress: ApplicationProgress }) {
  return (
    <ol aria-label="Application steps" className="space-y-3">
      {progress.steps.map((step) => {
        const done = step.state === 'complete';
        const current = step.state === 'current';
        return (
          <li key={step.kind} className="flex items-start gap-3 text-sm" aria-current={current ? 'step' : undefined}>
            <span
              aria-hidden
              className={cn(
                'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                done && 'border-navy-900 bg-navy-900 text-white',
                current && 'border-navy-900 bg-surface',
                !done && !current && 'border-line bg-surface',
              )}
            >
              {done && <Check className="size-3" strokeWidth={3} />}
              {current && <span className="size-2 rounded-full bg-navy-900" />}
            </span>
            <span className="min-w-0">
              <span className={cn('block', current ? 'font-semibold text-navy-900' : done ? 'text-ink' : 'text-muted')}>
                {step.label}
                <span className="sr-only">{done ? ' (done)' : current ? ' (current)' : ' (not started)'}</span>
              </span>
              {done && step.at && (
                <span className="block text-xs text-muted">
                  {formatDate(step.at)}
                  {step.actor === 'simulation' && (
                    <span className="ml-2 rounded-full bg-warning-50 px-2 py-0.5 text-[11px] font-semibold text-warning-600">
                      Simulated
                    </span>
                  )}
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
