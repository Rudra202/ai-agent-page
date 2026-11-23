import {
  BUSINESS_ACTIVITIES,
  DOCUMENT_TYPES,
  FINANCE_AMOUNT_CHIPS,
  FINANCE_DISCLAIMER,
  FINANCE_INFORMATION_REQUESTS,
  FINANCE_PURPOSES,
  FINANCE_REQUIRED_DOCUMENTS,
  JURISDICTIONS,
  PACKAGES,
  PROGRESS_STEPS,
  REGISTRATION_OPTIONS,
  REGISTRATION_TYPES,
  requiredDocumentsFor,
  SAMPLE_DATA_NOTE,
} from '@tajir/shared';
import type { ServiceRecord } from '../domain/entities.js';
import type { Repositories } from '../repositories/types.js';

/** The two services and their configuration, taken from the shared sample catalogue. */
export function buildServiceDefinitions(): Array<Omit<ServiceRecord, 'id'>> {
  return [
    {
      slug: 'company_registration',
      type: 'company_registration',
      name: 'Company Registration',
      description: 'Set up a new company on the UAE Mainland, in a Free Zone or Offshore, guided step by step.',
      steps: PROGRESS_STEPS.company_registration.map((s) => ({ kind: s.kind, label: s.label })),
      config: {
        note: SAMPLE_DATA_NOTE,
        registrationTypes: REGISTRATION_OPTIONS,
        jurisdictions: JURISDICTIONS,
        packages: PACKAGES,
        activities: BUSINESS_ACTIVITIES,
        documentTypes: DOCUMENT_TYPES,
        requiredDocuments: Object.fromEntries(REGISTRATION_TYPES.map((type) => [type, requiredDocumentsFor(type)])),
      },
      sample: true,
    },
    {
      slug: 'working_capital_finance',
      type: 'working_capital_finance',
      name: 'Working Capital Finance',
      description: 'Record a working capital request and track what is needed. Prototype only: no financing is offered or approved.',
      steps: PROGRESS_STEPS.working_capital_finance.map((s) => ({ kind: s.kind, label: s.label })),
      config: {
        note: FINANCE_DISCLAIMER,
        purposes: FINANCE_PURPOSES,
        amountSuggestions: FINANCE_AMOUNT_CHIPS,
        requiredDocuments: FINANCE_REQUIRED_DOCUMENTS,
        informationRequests: FINANCE_INFORMATION_REQUESTS,
        documentTypes: DOCUMENT_TYPES,
      },
      sample: true,
    },
  ];
}

/** Makes the Service collection match the shared catalogue. Safe to run on every start. */
export async function seedServices(repos: Repositories): Promise<void> {
  for (const definition of buildServiceDefinitions()) await repos.services.upsert(definition);
}
