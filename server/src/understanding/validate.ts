import { UNDERSTANDING_DISCLAIMER, UNDERSTANDING_FIELDS } from '@tajir/shared';
import type { DocumentUnderstanding, UnderstandingType } from '@tajir/shared';
import { wireSchemaFor } from './schemas.js';

/** Thrown when the AI's answer cannot be used at all (wrong shape). Nothing from it is kept. */
export class UnusableReadingError extends Error {
  constructor() {
    super('The AI answer did not match the required shape');
    this.name = 'UnusableReadingError';
  }
}

const MAX_VALUE = 300;
const MAX_ITEMS = 12;
const MAX_SUMMARY = 400;
const MAX_OBSERVATION = 200;
const MAX_OBSERVATIONS = 5;

/** Letters and digits only, lower case, so spacing, line breaks and punctuation do not decide whether a value matches. */
const squash = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Statements the system never makes about a document and so never keeps from an AI: that it is genuine, valid,
 * current, approved, legal or compliant. Those need an official check, which this is not. Links are dropped too,
 * since an AI that has been fooled by a document could be made to write one.
 */
const UNSAFE_STATEMENT =
  /\b(verif(y|ied|ies|ication)|authentic(ity)?|genuine|legitimate|valid(ated|ity)?|invalid|legal(ly)?|lawful|compliant|compliance|approved|approval|guarantee[sd]?|certified|forged|forgery|fake|fraud(ulent)?|counterfeit|expired|not expired|in force|eligible|eligibility)\b|https?:\/\/|www\.|\]\(/i;

const clean = (value: string, max: number): string => value.replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Turns an AI answer into the stored reading, trusting none of it:
 *  - the shape is checked,
 *  - every fact must appear in the document's own text, or it is blanked (an AI cannot add a value the document does not have),
 *  - what is missing is worked out here from the blanks, not taken from the AI,
 *  - the AI's own statements are kept only if they make no claim of verification, validity or the like, and contain no links.
 */
export function buildReading(type: UnderstandingType | 'other', answer: unknown, sourceText: string): { reading: DocumentUnderstanding; aiType: string } {
  const parsed = wireSchemaFor(type).safeParse(answer);
  if (!parsed.success) throw new UnusableReadingError();
  const wire = parsed.data as { documentType: string; facts?: Record<string, string | string[] | null>; summary: string | null; observations: string[] };

  const source = squash(sourceText);
  const notes: string[] = [];
  const facts: DocumentUnderstanding['facts'] = {};
  const missing: string[] = [];

  if (type !== 'other') {
    for (const field of UNDERSTANDING_FIELDS[type]) {
      const raw = wire.facts?.[field.key];
      const grounded = (value: string): string | null => {
        const text = clean(value, MAX_VALUE);
        const squashed = squash(text);
        return squashed.length > 0 && source.includes(squashed) ? text : null;
      };
      if (field.list) {
        const values = (Array.isArray(raw) ? raw : []).slice(0, MAX_ITEMS).map((v) => (typeof v === 'string' ? grounded(v) : null));
        const kept = values.filter((v): v is string => v !== null);
        if (values.length > kept.length) notes.push(`Some of "${field.label}" could not be found in the document text, so it was left out.`);
        facts[field.key] = kept.length ? kept : null;
      } else {
        const text = typeof raw === 'string' ? raw : null;
        const found = text === null ? null : grounded(text);
        if (text !== null && text.trim() && found === null) notes.push(`"${field.label}" could not be matched to the document text, so it was left blank.`);
        facts[field.key] = found;
      }
      if (facts[field.key] === null) missing.push(field.label);
    }
  }

  const safe = (text: string, max: number): string | null => {
    const cleaned = clean(text, max);
    return cleaned && !UNSAFE_STATEMENT.test(cleaned) ? cleaned : null;
  };
  const summary = wire.summary === null ? null : safe(wire.summary, MAX_SUMMARY);
  if (wire.summary && summary === null) notes.push('The AI summary was removed because it made a claim that cannot be checked here.');
  const observations: string[] = [];
  let dropped = 0;
  for (const item of wire.observations.slice(0, MAX_OBSERVATIONS * 2)) {
    const kept = safe(item, MAX_OBSERVATION);
    if (kept && observations.length < MAX_OBSERVATIONS) observations.push(kept);
    else if (!kept) dropped += 1;
  }
  if (dropped > 0) notes.push(`${dropped} AI observation(s) were removed because they made claims that cannot be checked here.`);

  return {
    aiType: wire.documentType,
    reading: {
      schemaVersion: 1,
      documentType: type,
      facts,
      interpretation: { summary, observations, missingInformation: missing },
      notes,
      disclaimer: UNDERSTANDING_DISCLAIMER,
    },
  };
}
