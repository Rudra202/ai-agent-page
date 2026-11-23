/** Application lifecycle statuses, in display order. */
export const APPLICATION_STATUSES = [
  'request_understood',
  'information_required',
  'documents_pending',
  'preparation',
  'submitted',
  'under_review',
  'completed',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  request_understood: 'Request Understood',
  information_required: 'Information Required',
  documents_pending: 'Documents Pending',
  preparation: 'Preparation',
  submitted: 'Submitted',
  under_review: 'Under Review',
  completed: 'Completed',
};

/** Activity dashboard buckets. */
export const ACTIVITY_FILTERS = ['needs_action', 'in_progress', 'completed'] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  needs_action: 'Needs Action',
  in_progress: 'In Progress',
  completed: 'Completed',
};

export function activityFilterFor(status: ApplicationStatus): ActivityFilter {
  switch (status) {
    case 'information_required':
    case 'documents_pending':
      return 'needs_action';
    case 'completed':
      return 'completed';
    default:
      return 'in_progress';
  }
}

/** Progress in the range 0..1 for a progress indicator. */
export function statusProgress(status: ApplicationStatus): number {
  const index = APPLICATION_STATUSES.indexOf(status);
  return (index + 1) / APPLICATION_STATUSES.length;
}
