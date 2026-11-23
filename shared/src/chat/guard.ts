/**
 * The claims guard. Free text written by an AI model is only ever shown to the user
 * after it passes these checks, and only for general conversation. It exists because
 * the app must never invent fees, legal eligibility, government approvals or
 * financing offers, and a model cannot be trusted to hold that line on its own.
 * Anything that fails is replaced by a fixed message written by us.
 */

export const RESTRICTED_REPLY =
  "I can't confirm fees, eligibility rules, legal requirements, approvals or financing terms. The figures on the option cards are sample information for this prototype, so please check with the relevant authority or provider before relying on them.";

export const NEUTRAL_REPLY = "I can help you set up a company or record a working capital request. Let's carry on.";

export const GENERAL_INFO_NOTE = 'This is general information only. It is not legal advice and not a confirmation of any fee, eligibility or approval.';

interface Rule {
  id: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  // Money: amounts in any currency, or numbers followed by a currency or magnitude.
  { id: 'money', pattern: /(?:\baed\b|\bdhs?\b|\bdirhams?\b|\busd\b|[$€£])\s*\d|\d[\d,.]*\s*(?:aed|dhs?|dirhams?|usd|k\b|m\b|million|thousand)/i },
  { id: 'percentage', pattern: /\d\s*%|\bpercent(?:age)?\b/i },
  // Timeframes are invented processing times.
  { id: 'timeframe', pattern: /\b\d+\s*(?:(?:-|to)\s*\d+\s*)?(?:business\s+|working\s+)?(?:days?|weeks?|months?|hours?|years?)\b/i },
  { id: 'fees', pattern: /\b(?:fees?|costs?|costing|charges?|prices?|priced|pricing|free of charge|no charge|waived|discount\w*|cheap(?:er|est)?|affordable)\b/i },
  // Claims about who qualifies, what the law requires, or what is allowed. Describing what something is ("a regulatory
  // framework", "legal entity") is not a claim, so the plain words are not enough on their own.
  {
    id: 'eligibility_or_legal',
    pattern: /\beligib\w*|\bqualif(?:y|ies|ied|ication\w*)\b|\blegally\b|\billegal\b|\bunlawful\b|\bby law\b|\b(?:the )?law (?:says|states|requires|requires|allows|forbids)\b|\brequired by (?:law|the (?:authority|government|regulator))\b|\bsanction\w*|\bmandatory\b|\bpermitted\b|\bnot allowed\b|\b(?:you|they|companies|applicants|foreigners|owners) (?:must|need to|have to|are required to|are not allowed to|cannot|can't|may not)\b/i,
  },
  { id: 'outcome_claims', pattern: /\b(?:(?:we|i)(?:'ve| have| had)?\s+(?:just\s+)?(?:submitted|filed|registered|approved|processed|completed|issued)|your\s+(?:application|company|licen[cs]e|request|registration)\s+(?:is|was|has been)\s+(?:submitted|filed|registered|approved|issued|complete\w*|done)|approved|approval|pre-?approved|guarantee[ds]?|guaranteed|will be (?:approved|accepted|granted|issued|registered)|has been (?:approved|accepted|granted|issued|registered|submitted|completed)|have been (?:approved|accepted|granted|issued|registered|submitted)|is (?:approved|registered|completed?)|congratulations|successfully (?:registered|submitted|approved|completed))\b/i },
  { id: 'financing_offer', pattern: /\b(?:interest|apr|annual percentage|loan offer|offer(?:s|ed)? you|credit (?:limit|line)|lend(?:er|ing)?|repay\w*|instal+ments?|pre-?qualif\w*|rates?)\b/i },
  { id: 'links_or_contacts', pattern: /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{8,}/i },
  { id: 'markup_or_code', pattern: /```|<\/?[a-z][^>]*>|\bjavascript:|\{\{|\}\}|\$\{/i },
  { id: 'prompt_or_secret', pattern: /\b(?:system|developer) (?:prompt|message|instructions?)\b|\bapi[ _-]?key\b|\bsk-[A-Za-z0-9_-]{8,}|\bpassword\b|\bignore (?:all |the |my )?(?:previous|above|prior)\b|\bas an ai\b|\bi am (?:an? )?(?:ai|language model)\b/i },
];

export const MAX_ASSISTANT_TEXT = 700;

export type GuardResult = { ok: true; text: string } | { ok: false; reasons: string[] };

/** Checks a piece of model-written text. Returns the cleaned text, or the reasons it was refused. */
export function checkAssistantText(raw: string): GuardResult {
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  const reasons: string[] = [];
  if (!text) reasons.push('empty');
  if (text.length > MAX_ASSISTANT_TEXT) reasons.push('too_long');
  for (const rule of RULES) if (rule.pattern.test(text)) reasons.push(rule.id);
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, text };
}

/**
 * Topics the app will not discuss from model knowledge, whatever the model says.
 * Matched against what the USER wrote, so the model is not even asked to answer.
 */
const RESTRICTED_USER_TOPICS =
  /\b(?:fees?|costs?|prices?|pricing|how much|charges?|eligib\w*|qualif\w*|legal\w*|laws?|regulat\w*|visas?|approv\w*|permits?|interest|apr|repay\w*|guarantee\w*|allowed|permitted|tax(?:es)?|vat|offer me|can i get)\b/i;

export function isRestrictedTopic(userText: string): boolean {
  return RESTRICTED_USER_TOPICS.test(userText);
}

/** Does the user's own message look like a question rather than an answer to the current prompt? */
export function looksLikeQuestion(userText: string): boolean {
  const text = userText.trim();
  if (!text) return false;
  if (text.endsWith('?')) return true;
  return /^(?:what|why|how|when|where|who|which|can|could|should|would|do|does|is|are|will|tell me|explain)\b/i.test(text) && text.split(/\s+/).length >= 3;
}

// ------------------------------------------------------------ general questions

/**
 * Words that put a question inside Tajir's own subject: setting up a UAE company, licences, visas,
 * taxes, fees, legal rules, approvals and financing. Questions about these are answered under the
 * strict rules above. Everything else is a general question and gets the lighter checks below.
 */
const SERVICE_TOPIC =
  /\b(?:uae|emirates?|emirati|free\s?-?zones?|mainland|offshore|licen[cs]es?|incorporat\w*|regist(?:er|ered|ering|ration)|compan(?:y|ies)|business(?:es)?|visas?|residen(?:ce|cy)|ejari|vat|tax(?:es)?|loans?|financ(?:e|ing)|working capital|jafza|dmcc|ifza|shams|packages?|shareholders?|sponsor\w*|applications?)\b/i;

export function isServiceTopic(userText: string): boolean {
  return SERVICE_TOPIC.test(userText);
}

export const MAX_GENERAL_TEXT = 1200;

/**
 * For an ordinary question the model may write a longer, natural answer. Only things that could harm the
 * user or mislead them about THIS app are refused: links and contact details (a model can invent them),
 * markup, anything that reveals instructions or secrets, and claims that the user's own application or
 * licence has been submitted, approved or issued.
 */
const GENERAL_RULES: Rule[] = [
  {
    id: 'application_claims',
    pattern: /\b(?:(?:we|i)(?:'ve| have| had)?\s+(?:just\s+)?(?:submitted|filed|registered|approved|processed|issued)\s+(?:your|the)\b|your\s+(?:application|company|licen[cs]e|request|registration)\s+(?:is|was|has been)\s+(?:submitted|filed|registered|approved|issued|complete\w*|done))/i,
  },
  { id: 'links_or_contacts', pattern: /https?:\/\/|\bwww\.|[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b|\+\d{8,}/i },
  { id: 'markup_or_code', pattern: /<\/?[a-z][^>]*>|\bjavascript:|\{\{|\}\}|\$\{/i },
  { id: 'prompt_or_secret', pattern: /\b(?:system|developer) (?:prompt|message|instructions?)\b|\bapi[ _-]?key\b|\bsk-[A-Za-z0-9_-]{8,}|\bpassword\b|\bignore (?:all |the |my )?(?:previous|above|prior)\b/i },
];

function cutAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('\n'));
  return end > max * 0.5 ? head.slice(0, end + 1).trim() : `${head.trim()}...`;
}

/** Checks the model's answer to a general question. Keeps paragraph breaks and trims an over-long answer at a sentence. */
export function checkGeneralAnswer(raw: string): GuardResult {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return { ok: false, reasons: ['empty'] };
  const text = cutAtSentence(cleaned, MAX_GENERAL_TEXT);
  const reasons = GENERAL_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, text };
}
