import { AlertTriangle, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import type { AssistantMessage } from '../types';

type SummaryMessage = Extract<AssistantMessage, { kind: 'summary' }>;

/** Review card inside the conversation, ending in "Confirm & Submit". */
export function SummaryCard({
  message,
  active,
  onConfirm,
}: {
  message: SummaryMessage;
  active: boolean;
  onConfirm: () => void;
}) {
  const blocked = message.problems.length > 0;
  return (
    <Card className="p-4">
      <h3 className="flex items-center gap-2 text-base font-semibold text-navy-900">
        <FileText className="size-5 text-brand-600" aria-hidden />
        {message.title}
      </h3>
      <dl className="mt-3 divide-y divide-line text-sm">
        {message.fields.map((field) => (
          <div key={field.label} className="flex justify-between gap-4 py-2">
            <dt className="shrink-0 text-muted">{field.label}</dt>
            <dd className="text-right font-medium text-navy-900">{field.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs text-muted">{message.note}</p>

      {blocked && (
        <div role="alert" className="mt-3 flex gap-2 rounded-control bg-warning-50 p-3 text-xs text-warning-600">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Incomplete: {message.problems.join('; ')}.</span>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <Button fullWidth disabled={!active || blocked} onClick={onConfirm}>
          Confirm &amp; Submit
        </Button>
        {message.workflow === 'company_registration' && (
          <Link
            to="/company-setup/review"
            className="flex h-11 w-full items-center justify-center rounded-control border border-line text-sm font-semibold text-navy-900 hover:bg-brand-50"
          >
            Review &amp; edit details
          </Link>
        )}
      </div>
    </Card>
  );
}
