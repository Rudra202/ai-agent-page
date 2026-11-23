/** The most document text ever sent to an AI model. Longer documents are cut, and the result says so. */
export const MAX_AI_CHARS = 12_000;

/**
 * Removes what an AI model has no need to see before a document's text is sent to it: national ID numbers,
 * bank account numbers (IBANs) and card-like numbers, passport machine-readable lines (they repeat the passport
 * number and date of birth), and email addresses. Everything the reading needs stays, and the stored text is never changed.
 */
export function redactForAi(text: string): { text: string; redactions: number } {
  let redactions = 0;
  const swap = (pattern: RegExp, label: string) => {
    text = text.replace(pattern, () => {
      redactions += 1;
      return label;
    });
  };
  swap(/\b784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d\b/g, '[ID NUMBER REMOVED]');
  swap(/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, '[ACCOUNT NUMBER REMOVED]');
  swap(/\b(?:\d[ -]?){13,19}\b/g, '[NUMBER REMOVED]');
  swap(/^[A-Z0-9<]{28,44}$/gm, '[MACHINE-READABLE LINE REMOVED]');
  swap(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL REMOVED]');
  return { text, redactions };
}
