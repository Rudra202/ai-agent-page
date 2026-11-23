/**
 * What the system reads out of a document, and how it is labelled.
 *
 * Two parts are kept apart on purpose, because they are not equally trustworthy:
 *  - `facts` are words copied from the document, and each one was checked to appear in the document's text.
 *  - `interpretation` is what an AI model made of them. It can be wrong, and it never says a document is genuine or valid.
 * Missing information is `null`. Nothing is guessed to fill a gap.
 */

export const UNDERSTANDING_TYPES = ['trade_licence', 'passport', 'bank_statement', 'business_plan'] as const;
export type UnderstandingType = (typeof UNDERSTANDING_TYPES)[number];

export interface UnderstandingField {
  key: string;
  label: string;
  /** The field is a list of values rather than one. */
  list?: boolean;
}

export const UNDERSTANDING_FIELDS: Record<UnderstandingType, UnderstandingField[]> = {
  trade_licence: [
    { key: 'licenceNumber', label: 'Licence number' },
    { key: 'companyName', label: 'Company name' },
    { key: 'legalForm', label: 'Legal form' },
    { key: 'issuingAuthority', label: 'Issuing authority' },
    { key: 'businessActivities', label: 'Business activities', list: true },
    { key: 'issueDate', label: 'Issue date' },
    { key: 'expiryDate', label: 'Expiry date' },
    { key: 'registeredAddress', label: 'Address' },
  ],
  passport: [
    { key: 'fullName', label: 'Full name' },
    { key: 'passportNumber', label: 'Passport number' },
    { key: 'nationality', label: 'Nationality' },
    { key: 'dateOfBirth', label: 'Date of birth' },
    { key: 'placeOfBirth', label: 'Place of birth' },
    { key: 'issueDate', label: 'Issue date' },
    { key: 'expiryDate', label: 'Expiry date' },
  ],
  bank_statement: [
    { key: 'bankName', label: 'Bank' },
    { key: 'accountHolder', label: 'Account holder' },
    { key: 'currency', label: 'Currency' },
    { key: 'statementPeriodStart', label: 'Period from' },
    { key: 'statementPeriodEnd', label: 'Period to' },
    { key: 'openingBalance', label: 'Opening balance' },
    { key: 'closingBalance', label: 'Closing balance' },
  ],
  business_plan: [
    { key: 'businessName', label: 'Business name' },
    { key: 'businessDescription', label: 'What the business does' },
    { key: 'productsOrServices', label: 'Products or services', list: true },
    { key: 'targetMarket', label: 'Target market' },
    { key: 'fundingRequired', label: 'Funding required' },
    { key: 'projectedRevenue', label: 'Projected revenue' },
  ],
};

export const UNDERSTANDING_DISCLAIMER =
  'Read automatically from the document text. It has not been checked with the issuing authority or any official source, so please review it.';

export interface DocumentUnderstanding {
  schemaVersion: 1;
  /** Which kind of document the reading is for: one of UNDERSTANDING_TYPES, or "other". */
  documentType: string;
  /** Values as written in the document. `null` where the document does not say. */
  facts: Record<string, string | string[] | null>;
  /** The AI's own reading. Interpretation, not fact. */
  interpretation: {
    summary: string | null;
    observations: string[];
    missingInformation: string[];
  };
  /** What the system itself noticed while checking the AI's answer. */
  notes: string[];
  disclaimer: string;
}

export function isUnderstandingType(value: string): value is UnderstandingType {
  return (UNDERSTANDING_TYPES as readonly string[]).includes(value);
}
