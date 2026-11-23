import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { computeProgress, PROGRESS_STEPS } from '@tajir/shared';
import type { EventActor, EventKind, WorkflowEvent } from '@tajir/shared';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { SelectionCard } from './SelectionCard';
import { StatusBadge } from './Badge';
import { ProgressBar, ProgressSteps } from './WorkflowProgress';

describe('Button', () => {
  it('fires onClick and blocks clicks while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('SelectionCard', () => {
  it('exposes radio semantics and reports selection', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<SelectionCard title="Free Zone" selected={false} onSelect={onSelect} />);
    const radio = screen.getByRole('radio', { name: /free zone/i });
    expect(radio).toHaveAttribute('aria-checked', 'false');
    await user.click(radio);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

function events(kinds: EventKind[], actor: EventActor = 'system'): WorkflowEvent[] {
  return kinds.map((kind, i) => ({ id: `e${i}`, at: `2026-11-2${i}T12:00:00Z`, kind, actor, title: kind }));
}

describe('workflow progress', () => {
  it('reports the share of steps that actually happened through an accessible progressbar', () => {
    const progress = computeProgress('company_registration', events(['request_understood', 'details_confirmed']));
    render(<ProgressBar progress={progress} />);
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '33');
    expect(bar).toHaveAttribute('aria-valuetext', '2 of 6 steps done, next: Documents ready');
  });

  it('marks a step done only when its event exists, and shows the service-specific labels', () => {
    const progress = computeProgress('working_capital_finance', events(['request_understood', 'details_confirmed']));
    render(<ProgressSteps progress={progress} />);
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\d{4}-\d{2}-\d{2}/, ''))).toEqual([
      'Request understood (done)',
      'Request confirmed (done)',
      'Documents and information received (current)',
      'Preparation (not started)',
      'Under review (not started)',
      'Completed (not started)',
    ]);
    expect(items.filter((li) => li.getAttribute('aria-current') === 'step')).toHaveLength(1);
  });

  it('shows the date a step happened and nothing for steps that have not', () => {
    const progress = computeProgress('company_registration', events(['request_understood']));
    render(<ProgressSteps progress={progress} />);
    expect(screen.getByText('2026-11-20')).toBeInTheDocument();
    expect(screen.getAllByText(/^\d{4}-\d{2}-\d{2}$/)).toHaveLength(1);
  });

  it('labels steps recorded by the simulation', () => {
    const all = PROGRESS_STEPS.company_registration.map((s) => s.kind);
    const log = [...events(all.slice(0, 4)), ...events(['under_review'], 'simulation').map((e) => ({ ...e, id: 'sim' }))];
    render(<ProgressSteps progress={computeProgress('company_registration', log)} />);
    expect(screen.getAllByText('Simulated')).toHaveLength(1);
  });

  it('shows every step as done only for a completed history', () => {
    const all = PROGRESS_STEPS.company_registration.map((s) => s.kind);
    render(<ProgressSteps progress={computeProgress('company_registration', events(all))} />);
    expect(screen.getAllByText(/\(done\)/)).toHaveLength(6);
  });
});

describe('StatusBadge', () => {
  it('shows the human-readable status label', () => {
    render(<StatusBadge status="documents_pending" />);
    expect(screen.getByText('Documents Pending')).toBeInTheDocument();
  });
});
