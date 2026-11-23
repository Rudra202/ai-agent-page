import type { ReactNode } from 'react';
import type { ActivityFilter, ApplicationStatus } from '@tajir/shared';
import { activityFilterFor, APPLICATION_STATUS_LABELS } from '@tajir/shared';
import { cn } from '../../lib/cn';

type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

const tones: Record<Tone, string> = {
  neutral: 'bg-canvas text-muted',
  info: 'bg-brand-50 text-brand-700',
  warning: 'bg-warning-50 text-warning-600',
  success: 'bg-success-50 text-success-600',
  danger: 'bg-danger-50 text-danger-600',
};

export function Badge({
  tone = 'neutral',
  children,
  'data-testid': testId,
}: {
  tone?: Tone;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold',
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

const filterTone: Record<ActivityFilter, Tone> = {
  needs_action: 'warning',
  in_progress: 'info',
  completed: 'success',
};

/** Badge whose colour follows the activity bucket of an application status. */
export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <Badge tone={filterTone[activityFilterFor(status)]} data-testid="status-badge">
      {APPLICATION_STATUS_LABELS[status]}
    </Badge>
  );
}
