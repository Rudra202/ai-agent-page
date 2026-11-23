import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { activityFilterFor, ACTIVITY_FILTER_LABELS, ACTIVITY_FILTERS, statusOf, updatedAtOf } from '@tajir/shared';
import type { ActivityFilter } from '@tajir/shared';
import { PageHeader } from '../components/layout/PageHeader';
import { EmptyState } from '../components/ui/EmptyState';
import { ApplicationCard } from '../features/applications/components/ApplicationCard';
import { cn } from '../lib/cn';
import { useApp } from '../state/context';

type Tab = 'all' | ActivityFilter;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'All' },
  ...ACTIVITY_FILTERS.map((f) => ({ id: f as Tab, label: ACTIVITY_FILTER_LABELS[f] })),
];

const EMPTY_COPY: Record<Tab, string> = {
  all: 'Nothing here yet. Start something from Home.',
  needs_action: 'Nothing needs your attention right now.',
  in_progress: 'No applications are in progress.',
  completed: 'No completed applications yet.',
};

export function ActivityPage() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>('needs_action');

  const sorted = [...state.applications].sort((a, b) => updatedAtOf(b).localeCompare(updatedAtOf(a)));
  const visible = tab === 'all' ? sorted : sorted.filter((a) => activityFilterFor(statusOf(a)) === tab);

  return (
    <>
      <PageHeader title="Activity" subtitle="Your applications, tasks & filings" />

      <div role="tablist" aria-label="Filter activity" className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="activity-panel"
            onClick={() => setTab(t.id)}
            className={cn(
              'shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors',
              tab === t.id ? 'bg-navy-900 text-white' : 'border border-line bg-surface text-muted hover:bg-brand-50',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="activity-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {visible.length === 0 ? (
          <EmptyState icon={<Inbox className="size-6" aria-hidden />} title={EMPTY_COPY[tab]} />
        ) : (
          <ul className="space-y-3">
            {visible.map((app) => (
              <li key={app.id}>
                <ApplicationCard app={app} variant="activity" />
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-6 text-center text-sm">
        <Link to="/applications" className="font-semibold text-brand-700 hover:underline">
          View all applications
        </Link>
      </p>
    </>
  );
}
