import type { WorkflowEvent } from '@tajir/shared';
import { formatShortDate } from '../../../lib/format';

/** Application history exactly as recorded, newest first. Simulated steps are labelled. */
export function Timeline({ events }: { events: WorkflowEvent[] }) {
  const ordered = events.map((event, index) => ({ event, index })).sort((a, b) => b.event.at.localeCompare(a.event.at) || b.index - a.index);
  return (
    <ol aria-label="Application history" className="space-y-4">
      {ordered.map(({ event }) => (
        <li key={event.id} className="flex gap-4 text-sm">
          <time dateTime={event.at} className="w-12 shrink-0 pt-0.5 text-xs font-medium text-muted">
            {formatShortDate(event.at)}
          </time>
          <div>
            <p className="font-semibold text-navy-900">
              {event.title}
              {event.actor === 'simulation' && (
                <span className="ml-2 rounded-full bg-warning-50 px-2 py-0.5 align-middle text-[11px] font-semibold text-warning-600">
                  Simulated
                </span>
              )}
            </p>
            {event.detail && <p className="text-xs text-muted">{event.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
