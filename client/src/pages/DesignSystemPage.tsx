import { Building2, Globe2, Landmark } from 'lucide-react';
import { useState } from 'react';
import { APPLICATION_STATUSES, computeProgress } from '@tajir/shared';
import type { WorkflowEvent } from '@tajir/shared';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge, StatusBadge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
import { Card, CardDescription, CardTitle } from '../components/ui/Card';
import { SelectionCard } from '../components/ui/SelectionCard';
import { ProgressBar, ProgressSteps } from '../components/ui/WorkflowProgress';

const SAMPLE_EVENTS: WorkflowEvent[] = (['request_understood', 'details_confirmed'] as const).map((kind, i) => ({
  id: `sample-${i}`,
  at: '2026-11-20T09:00:00Z',
  kind,
  actor: 'system',
  title: kind,
}));
const SAMPLE_PROGRESS = computeProgress('company_registration', SAMPLE_EVENTS);

/** Living style guide for the design system. Not linked from the main navigation. */
export function DesignSystemPage() {
  const [choice, setChoice] = useState<string>('free_zone');

  return (
    <div className="space-y-8">
      <PageHeader title="Design system" subtitle="Tokens and reusable components used across Tajir AI." />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Buttons</h2>
        <div className="flex flex-wrap gap-3">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button loading>Loading</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Selection cards</h2>
        <div role="radiogroup" aria-label="Registration type" className="grid gap-3">
          {[
            { id: 'mainland', title: 'UAE Mainland', description: 'Sample description', icon: <Landmark className="size-5" /> },
            { id: 'free_zone', title: 'Free Zone', description: 'Sample description', icon: <Building2 className="size-5" /> },
            { id: 'offshore', title: 'Offshore', description: 'Sample description', icon: <Globe2 className="size-5" /> },
          ].map((o) => (
            <SelectionCard
              key={o.id}
              title={o.title}
              description={o.description}
              icon={o.icon}
              selected={choice === o.id}
              onSelect={() => setChoice(o.id)}
            />
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Status</h2>
        <Card>
          <CardTitle>Sample application</CardTitle>
          <CardDescription>Sample data only.</CardDescription>
          <div className="my-4">
            <ProgressBar progress={SAMPLE_PROGRESS} />
            <div className="mt-4">
              <ProgressSteps progress={SAMPLE_PROGRESS} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {APPLICATION_STATUSES.map((s) => (
              <StatusBadge key={s} status={s} />
            ))}
            <Badge>Neutral</Badge>
          </div>
        </Card>
      </section>
    </div>
  );
}
