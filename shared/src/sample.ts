import type { Application } from './applications.js';
import type { EventActor, EventKind, WorkflowEvent } from './progress.js';

/**
 * Sample data for the prototype and for tests. Dates are relative to "now" so a
 * demo never looks stale. The applications are event logs that obey the same
 * rules as live ones (a test replays them through the workflow).
 */

const DAY = 86_400_000;
const iso = (now: Date, daysFromNow: number) => new Date(now.getTime() + daysFromNow * DAY).toISOString();

export const SAMPLE_COMPANY = 'ABC Trading LLC';

export function createSampleApplications(now: Date, newId: () => string): Application[] {
  const ev = (
    kind: EventKind,
    days: number,
    title: string,
    detail?: string,
    extra: Partial<WorkflowEvent> = {},
    actor: EventActor = 'system',
  ): WorkflowEvent => ({ id: newId(), at: iso(now, days), kind, actor, title, detail, ...extra });

  return [
    {
      id: 'FIN-2026-050123',
      service: 'working_capital_finance',
      title: 'Working Capital Finance',
      subtitle: 'AED 350,000',
      details: [
        { label: 'Business', value: SAMPLE_COMPANY },
        { label: 'Amount requested', value: 'AED 350,000' },
        { label: 'Purpose', value: 'Inventory' },
      ],
      events: [
        ev('request_understood', -10, 'Request understood', 'Working Capital Finance'),
        ev('details_confirmed', -10, 'Request confirmed', 'AED 350,000 for Inventory', {}, 'user'),
        ev('requirement_requested', -9, 'Waiting for: Latest 6-month bank statement', 'Document needed', {
          requirement: {
            id: 'req-bank_statement_6m',
            label: 'Latest 6-month bank statement',
            kind: 'document',
            docTypeId: 'bank_statement_6m',
          },
        }),
      ],
    },
    {
      id: 'REG-2026-178295',
      service: 'company_registration',
      title: 'Company Registration',
      subtitle: 'New company - Free Zone',
      details: [
        { label: 'Registration type', value: 'Free Zone' },
        { label: 'Jurisdiction', value: 'IFZA (International Free Zone Authority)' },
      ],
      events: [ev('request_understood', -2, 'Request understood', 'Company Registration')],
    },
    {
      id: 'REG-2026-101443',
      service: 'company_registration',
      title: 'Company Registration',
      subtitle: SAMPLE_COMPANY,
      details: [
        { label: 'Registration type', value: 'UAE Mainland' },
        { label: 'Jurisdiction', value: 'Dubai Mainland' },
        { label: 'Company name', value: SAMPLE_COMPANY },
        { label: 'Record', value: 'Sample record' },
      ],
      events: [
        ev('request_understood', -380, 'Request understood', 'Company Registration'),
        ev('details_confirmed', -380, 'Details confirmed', undefined, {}, 'user'),
        ev('requirements_complete', -379, 'Documents ready'),
        ev('submitted', -378, 'Submitted', 'Sample record'),
        ev('under_review', -372, 'Under review', 'Sample record'),
        ev('completed', -365, 'Completed', 'Sample record: trade licence issued'),
      ],
    },
  ];
}

/** Document types the sample user already has on record. */
export const SAMPLE_DOCUMENT_TYPES = ['passport', 'emirates_id', 'proof_of_address', 'trade_licence', 'tenancy_contract'];
