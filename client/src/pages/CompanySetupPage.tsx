import { Check } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { COMPANY_REGISTRATION_STEPS, companySummaryFields, validateCompanyDraft } from '@tajir/shared';
import type { CompanyRegistrationStep } from '@tajir/shared';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card, CardDescription, CardTitle } from '../components/ui/Card';
import { cn } from '../lib/cn';
import { useApp } from '../state/context';

const STEP_LABELS: Record<CompanyRegistrationStep, string> = {
  intent: 'Get started',
  registration_type: 'Registration type',
  jurisdiction: 'Jurisdiction',
  business_details: 'Business details',
  package_selection: 'Package',
  review: 'Review',
  submitted: 'Submitted',
};

/** Overview of the guided company registration, with shortcuts into chat and review. */
export function CompanySetupPage() {
  const { state, sendText } = useApp();
  const navigate = useNavigate();
  const { workflow } = state;
  const active = workflow.type === 'company_registration';
  const steps: readonly CompanyRegistrationStep[] = COMPANY_REGISTRATION_STEPS.filter((s) => s !== 'intent');
  const currentIndex = active ? steps.indexOf(workflow.step as CompanyRegistrationStep) : -1;
  const complete = active && validateCompanyDraft(workflow.company).length === 0;

  return (
    <>
      <PageHeader title="Company setup" subtitle="Set up a new company step by step with Tajir." />
      <Card>
        <CardTitle>Your progress</CardTitle>
        <CardDescription>{active ? 'Pick up where you left off.' : 'You have not started a registration yet.'}</CardDescription>
        <ol aria-label="Registration steps" className="mt-4 space-y-3">
          {steps.map((step, index) => {
            const done = active && index < currentIndex;
            const current = active && index === currentIndex;
            return (
              <li key={step} className="flex items-center gap-3 text-sm" aria-current={current ? 'step' : undefined}>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border-2',
                    done && 'border-navy-900 bg-navy-900 text-white',
                    current && 'border-navy-900 bg-surface',
                    !done && !current && 'border-line bg-surface',
                  )}
                >
                  {done && <Check className="size-3" strokeWidth={3} />}
                  {current && <span className="size-2 rounded-full bg-navy-900" />}
                </span>
                <span className={cn(current ? 'font-semibold text-navy-900' : done ? 'text-ink' : 'text-muted')}>
                  {STEP_LABELS[step]}
                  <span className="sr-only">{done ? ' (done)' : current ? ' (current)' : ''}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </Card>

      {active && (
        <Card className="mt-4">
          <CardTitle>What you have told Tajir</CardTitle>
          <dl className="mt-3 divide-y divide-line text-sm">
            {companySummaryFields(workflow.company, state.user, state.documents)
              .filter((f) => f.label !== 'Documents')
              .map((field) => (
                <div key={field.label} className="flex justify-between gap-4 py-2">
                  <dt className="shrink-0 text-muted">{field.label}</dt>
                  <dd className="text-right font-medium text-navy-900">{field.value}</dd>
                </div>
              ))}
          </dl>
        </Card>
      )}

      <div className="mt-6 space-y-2">
        {active && workflow.step !== 'submitted' ? (
          <>
            <Button fullWidth size="lg" onClick={() => navigate('/chat')}>
              Continue in chat
            </Button>
            <Button fullWidth size="lg" variant="secondary" onClick={() => navigate('/company-setup/review')}>
              {complete ? 'Review & submit' : 'Review what I have so far'}
            </Button>
          </>
        ) : (
          <Button
            fullWidth
            size="lg"
            onClick={() => {
              void sendText('Start a company');
              navigate('/chat');
            }}
          >
            {active ? 'Start another company' : 'Start in chat'}
          </Button>
        )}
      </div>
    </>
  );
}
