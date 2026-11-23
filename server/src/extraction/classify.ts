import type { Confidence } from '../domain/documents.js';

export interface Classification {
  /** One of the shared DETECTED_DOCUMENT_TYPES ids. */
  type: string;
  confidence: Confidence;
}

interface Rule {
  type: string;
  /** Phrases that point to this type. Each is counted once. */
  signals: RegExp[];
  /** One strong signal is enough for "medium". */
  strong?: RegExp[];
}

const RULES: Rule[] = [
  {
    type: 'trade_licence',
    strong: [/\btrade\s+licen[cs]e\b/i, /\bcommercial\s+licen[cs]e\b/i, /\bprofessional\s+licen[cs]e\b/i],
    signals: [/\blicen[cs]e\s+(no|number)\b/i, /\bdepartment\s+of\s+(economy|economic)\b/i, /\blegal\s+(form|type)\b/i, /\bbusiness\s+activit(y|ies)\b/i, /\bissue\s+date\b/i, /\bexpiry\s+date\b/i, /\bmanager\b/i, /\bdubai\s+(economy|development)\b/i, /\bfree\s+zone\b/i, /\bregister(ed)?\s+(no|number)\b/i],
  },
  {
    type: 'passport',
    strong: [/\bP<[A-Z]{3}[A-Z<]{5,}/, /\bpassport\b/i],
    signals: [/\bsurname\b/i, /\bgiven\s+names?\b/i, /\bnationality\b/i, /\bdate\s+of\s+birth\b/i, /\bplace\s+of\s+birth\b/i, /\bdate\s+of\s+expiry\b/i, /\bpassport\s+no\b/i, /\bauthority\b/i, /[A-Z0-9<]{30,}/],
  },
  {
    type: 'emirates_id',
    strong: [/\bemirates\s+id\b/i, /\bresident\s+identity\s+card\b/i, /\bidentity\s+card\b.*\buae\b/i],
    signals: [/\b784-?\d{4}-?\d{7}-?\d\b/, /\bid\s+number\b/i, /\bunited\s+arab\s+emirates\b/i, /\bfederal\s+authority\b/i, /\bresidence\s+(permit|visa)\b/i, /\bname\b/i, /\bnationality\b/i],
  },
  {
    type: 'bank_statement',
    strong: [/\bstatement\s+of\s+account\b/i, /\baccount\s+statement\b/i, /\bbank\s+statement\b/i],
    signals: [/\bopening\s+balance\b/i, /\bclosing\s+balance\b/i, /\bavailable\s+balance\b/i, /\bdebit\b/i, /\bcredit\b/i, /\biban\b/i, /\baccount\s+(no|number)\b/i, /\btransactions?\b/i, /\bwithdrawals?\b/i, /\bdeposits?\b/i, /\bAED\b/],
  },
  {
    type: 'tenancy_contract',
    strong: [/\btenancy\s+contract\b/i, /\bejari\b/i, /\blease\s+agreement\b/i],
    signals: [/\blandlord\b/i, /\btenant\b/i, /\bannual\s+rent\b/i, /\bsecurity\s+deposit\b/i, /\bpremises\b/i, /\bplot\s+no\b/i, /\bproperty\s+(usage|type)\b/i, /\bcontract\s+period\b/i],
  },
  {
    type: 'business_plan',
    strong: [/\bbusiness\s+plan\b/i],
    signals: [/\bexecutive\s+summary\b/i, /\bmarket\s+analysis\b/i, /\bfinancial\s+(projections?|plan)\b/i, /\bmarketing\s+strategy\b/i, /\bswot\b/i, /\bvalue\s+proposition\b/i, /\btarget\s+market\b/i, /\brevenue\s+(model|streams?)\b/i, /\bcompetit(or|ive)s?\b/i, /\bmission\b/i],
  },
];

/**
 * Guesses what a document is from its words alone, with no AI. It is a reading of the text, not a verification:
 * it never says a document is real, valid or current. "Other" with low confidence is the honest answer when nothing fits.
 */
export function classifyDocument(text: string): Classification {
  const sample = text.slice(0, 20_000);
  let best: { type: string; score: number; strong: number } | null = null;
  for (const rule of RULES) {
    const strong = (rule.strong ?? []).filter((re) => re.test(sample)).length;
    const score = rule.signals.filter((re) => re.test(sample)).length + strong * 2;
    if (!best || score > best.score) best = { type: rule.type, score, strong };
  }
  if (!best || best.score < 2) return { type: 'other', confidence: 'low' };
  // One keyword on its own (a passing mention of "passport" in a letter) is only a weak hint, whatever it is.
  if (best.strong > 0 && best.score >= 5) return { type: best.type, confidence: 'high' };
  if (best.score >= 4) return { type: best.type, confidence: 'medium' };
  return { type: best.type, confidence: 'low' };
}
