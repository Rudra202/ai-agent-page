import type { RegistrationType } from './workflow.js';

/**
 * Configurable SAMPLE data for the prototype.
 *
 * Nothing in this file is real: names, costs, timelines and requirements are
 * placeholders so the journey can be demonstrated. Replace this file (or load it
 * from the Service collection in Phase 3) with verified data before any real use.
 * Prices are optional on purpose: when a figure is not configured, the UI shows
 * "Pricing on request" instead of inventing one.
 */

export const SAMPLE_DATA_NOTE = 'Sample information for this prototype. Not legal advice and not real fees.';

export interface RegistrationOption {
  id: RegistrationType;
  title: string;
  description: string;
  tags: string[];
  setupTime: string;
  estCost?: number;
  /** Plural noun used in prompts, for example "free zones". */
  jurisdictionNoun: string;
  eyebrow: string;
}

export const REGISTRATION_OPTIONS: RegistrationOption[] = [
  {
    id: 'mainland',
    title: 'UAE Mainland',
    description: 'Trade anywhere in the UAE, no restrictions',
    tags: ['100% owned', 'No foreign ownership limits'],
    setupTime: '1-2 weeks',
    estCost: 15000,
    jurisdictionNoun: 'emirates',
    eyebrow: 'POPULAR MAINLAND EMIRATES',
  },
  {
    id: 'free_zone',
    title: 'Free Zone',
    description: '100% foreign ownership, tax benefits',
    tags: ['Flexible setup', 'Full ownership'],
    setupTime: '3-7 days',
    estCost: 12900,
    jurisdictionNoun: 'free zones',
    eyebrow: 'POPULAR UAE FREE ZONES',
  },
  {
    id: 'offshore',
    title: 'Offshore',
    description: 'Ideal for holding companies & international trade',
    tags: ['Asset protection', 'No office required'],
    setupTime: '1 week',
    estCost: 8000,
    jurisdictionNoun: 'offshore jurisdictions',
    eyebrow: 'OFFSHORE JURISDICTIONS',
  },
];

export interface Jurisdiction {
  id: string;
  registrationType: RegistrationType;
  name: string;
  shortName: string;
  /** Completes the sentence "<shortName> is ...". */
  fit: string;
  description: string;
  tags: string[];
  location: string;
  processing: string;
  /** Approximate setup cost. Leave undefined when no figure is configured. */
  setupCostFrom?: number;
  aliases: string[];
}

export const JURISDICTIONS: Jurisdiction[] = [
  {
    id: 'dubai-mainland',
    registrationType: 'mainland',
    name: 'Dubai Mainland',
    shortName: 'Dubai Mainland',
    fit: 'a strong base for trading across the UAE',
    description: 'Trade across the UAE and with government entities',
    tags: ['Widest market access', 'Local office needed'],
    location: 'Dubai',
    processing: '1-2 weeks',
    setupCostFrom: 15000,
    aliases: ['dubai', 'dubai mainland'],
  },
  {
    id: 'abu-dhabi-mainland',
    registrationType: 'mainland',
    name: 'Abu Dhabi Mainland',
    shortName: 'Abu Dhabi Mainland',
    fit: 'well suited to businesses working with the capital region',
    description: 'Suited to businesses serving the capital region',
    tags: ['Government access', 'Local office needed'],
    location: 'Abu Dhabi',
    processing: '1-2 weeks',
    setupCostFrom: 14000,
    aliases: ['abu dhabi', 'abu dhabi mainland'],
  },
  {
    id: 'sharjah-mainland',
    registrationType: 'mainland',
    name: 'Sharjah Mainland',
    shortName: 'Sharjah Mainland',
    fit: 'a cost-conscious base for local trade',
    description: 'A cost-conscious base for local trade',
    tags: ['Lower overheads'],
    location: 'Sharjah',
    processing: '1-2 weeks',
    aliases: ['sharjah', 'sharjah mainland'],
  },
  {
    id: 'dmcc',
    registrationType: 'free_zone',
    name: 'DMCC (Dubai Multi Commodities Centre)',
    shortName: 'DMCC',
    fit: 'a well-known choice for trading, commodities and consulting',
    description: 'Best for trading, commodities & consulting',
    tags: ['Most trusted brand', 'Strong ecosystem'],
    location: 'Dubai',
    processing: '5-7 business days',
    setupCostFrom: 16500,
    aliases: ['dmcc', 'dubai multi commodities centre'],
  },
  {
    id: 'ifza',
    registrationType: 'free_zone',
    name: 'IFZA (International Free Zone Authority)',
    shortName: 'IFZA',
    fit: 'a cost-effective choice for SMEs and startups',
    description: 'Cost-effective for SMEs & startups',
    tags: ['Flexible visa packages', 'Low cost'],
    location: 'Dubai',
    processing: '3-5 business days',
    setupCostFrom: 12000,
    aliases: ['ifza', 'international free zone authority'],
  },
  {
    id: 'shams',
    registrationType: 'free_zone',
    name: 'Sharjah Media City (Shams)',
    shortName: 'Shams',
    fit: 'great for freelancing and media businesses with very competitive setup costs',
    description: 'Ideal for freelancers & media startups',
    tags: ['Budget friendly', 'Fast setup'],
    location: 'Sharjah',
    processing: '3-5 business days',
    setupCostFrom: 5000,
    aliases: ['shams', 'sharjah media city', 'sharjah media'],
  },
  {
    id: 'rak-offshore',
    registrationType: 'offshore',
    name: 'Ras Al Khaimah Offshore',
    shortName: 'RAK Offshore',
    fit: 'a common choice for holding structures',
    description: 'Holding structures and international trade',
    tags: ['Asset protection', 'No office required'],
    location: 'Ras Al Khaimah',
    processing: '5-7 business days',
    setupCostFrom: 8000,
    aliases: ['rak', 'ras al khaimah', 'rak offshore'],
  },
  {
    id: 'jafza-offshore',
    registrationType: 'offshore',
    name: 'JAFZA Offshore',
    shortName: 'JAFZA Offshore',
    fit: 'a Dubai-based option for international holding companies',
    description: 'Dubai-based option for international holdings',
    tags: ['Dubai address', 'No office required'],
    location: 'Dubai',
    processing: '5-7 business days',
    setupCostFrom: 9500,
    aliases: ['jafza', 'jafza offshore', 'jebel ali'],
  },
];

export interface PackageOption {
  id: string;
  jurisdictionId: string;
  name: string;
  includes: string[];
  requirements: string[];
  /** Leave undefined when no price is configured: the UI shows "Pricing on request". */
  price?: number;
}

const STARTER_INCLUDES = ['Trade licence application', 'Name reservation', 'Registration filing support'];
const GROWTH_INCLUDES = [...STARTER_INCLUDES, 'Visa application support (up to 2)', 'Business bank account introduction'];

function packagesFor(jurisdiction: Jurisdiction, starterPrice?: number, growthPrice?: number): PackageOption[] {
  const requirements = ['Passport copy for each shareholder', 'Emirates ID or residence visa', 'Proof of address'];
  if (jurisdiction.registrationType === 'offshore') requirements.push('Proof of source of funds');
  return [
    {
      id: `${jurisdiction.id}-starter`,
      jurisdictionId: jurisdiction.id,
      name: 'Starter',
      includes: STARTER_INCLUDES,
      requirements,
      price: starterPrice,
    },
    {
      id: `${jurisdiction.id}-growth`,
      jurisdictionId: jurisdiction.id,
      name: 'Growth',
      includes: GROWTH_INCLUDES,
      requirements,
      price: growthPrice,
    },
  ];
}

const PRICES: Record<string, [number?, number?]> = {
  'dubai-mainland': [15000, 21000],
  'abu-dhabi-mainland': [14000, 19500],
  'sharjah-mainland': [undefined, undefined],
  dmcc: [16500, 23000],
  ifza: [12000, 17500],
  shams: [5000, 9500],
  'rak-offshore': [8000, 12000],
  'jafza-offshore': [9500, 13500],
};

export const PACKAGES: PackageOption[] = JURISDICTIONS.flatMap((j) => packagesFor(j, ...(PRICES[j.id] ?? [])));

export function getRegistrationOption(id: RegistrationType | undefined): RegistrationOption | undefined {
  return REGISTRATION_OPTIONS.find((o) => o.id === id);
}
export function getJurisdiction(id: string | undefined): Jurisdiction | undefined {
  return JURISDICTIONS.find((j) => j.id === id);
}
export function jurisdictionsFor(type: RegistrationType | undefined): Jurisdiction[] {
  return JURISDICTIONS.filter((j) => j.registrationType === type);
}
export function getPackage(id: string | undefined): PackageOption | undefined {
  return PACKAGES.find((p) => p.id === id);
}
export function packagesForJurisdiction(jurisdictionId: string | undefined): PackageOption[] {
  return PACKAGES.filter((p) => p.jurisdictionId === jurisdictionId);
}

export const BUSINESS_ACTIVITIES = [
  { label: 'Media & Marketing', category: 'Media & Advertising' },
  { label: 'General Trading', category: 'Trading' },
  { label: 'Consulting', category: 'Professional Services' },
  { label: 'Technology & Software', category: 'Technology' },
  { label: 'E-commerce', category: 'Retail' },
];

export const BUSINESS_CATEGORIES = Array.from(new Set([...BUSINESS_ACTIVITIES.map((a) => a.category), 'Other']));

export function categoryForActivity(activity: string): string {
  const match = BUSINESS_ACTIVITIES.find((a) => a.label.toLowerCase() === activity.trim().toLowerCase());
  return match?.category ?? 'Other';
}

// ---------------------------------------------------------------- documents

export const DOCUMENT_TYPES: Record<string, { label: string; short: string }> = {
  passport: { label: 'Passport copy', short: 'passport copy' },
  emirates_id: { label: 'Emirates ID or residence visa', short: 'Emirates ID' },
  proof_of_address: { label: 'Proof of address', short: 'proof of address' },
  trade_licence: { label: 'Trade licence', short: 'trade licence' },
  tenancy_contract: { label: 'Tenancy contract (Ejari)', short: 'tenancy contract' },
  source_of_funds: { label: 'Proof of source of funds', short: 'proof of source of funds' },
  bank_statement_6m: { label: 'Latest 6-month bank statement', short: 'latest 6-month bank statement' },
  business_plan: { label: 'Business plan', short: 'business plan' },
  other: { label: 'Other document', short: 'document' },
};

/**
 * What a document's content looks like, as read by the system. A reading of the text, never a verification:
 * it does not say a document is genuine, valid or current.
 */
export const DETECTED_DOCUMENT_TYPES: Record<string, string> = {
  trade_licence: 'Trade licence',
  passport: 'Passport',
  emirates_id: 'Emirates ID',
  bank_statement: 'Bank statement',
  business_plan: 'Business plan',
  tenancy_contract: 'Tenancy contract',
  other: 'Other document',
};

export function detectedTypeLabel(detectedType: string): string {
  return DETECTED_DOCUMENT_TYPES[detectedType] ?? 'Other document';
}

export function documentLabel(typeId: string): string {
  return DOCUMENT_TYPES[typeId]?.label ?? typeId;
}

/** Documents required for a company registration of the given type (sample configuration). */
export function requiredDocumentsFor(type: RegistrationType | undefined): string[] {
  const base = ['passport', 'emirates_id', 'proof_of_address'];
  return type === 'offshore' ? [...base, 'source_of_funds'] : base;
}

// ----------------------------------------------------------------- finance

export const FINANCE_AMOUNT_CHIPS = [100000, 250000, 500000];
export const FINANCE_PURPOSES = ['Inventory', 'Payroll & expenses', 'Equipment', 'Other'];
export const FINANCE_REQUIRED_DOCUMENTS = ['bank_statement_6m'];
export const FINANCE_INFORMATION_REQUESTS = ['Annual turnover (AED)'];
export const FINANCE_DISCLAIMER =
  'This is a prototype workflow. It tracks a request but does not offer, price or approve real financing.';

export interface RequiredDocument {
  typeId: string;
  label: string;
  /** True when a record of this document type exists. */
  onRecord: boolean;
}

export function requiredDocumentStatus(typeIds: string[], documents: ReadonlyArray<{ typeId: string }>): RequiredDocument[] {
  return typeIds.map((typeId) => ({
    typeId,
    label: documentLabel(typeId),
    onRecord: documents.some((d) => d.typeId === typeId),
  }));
}
