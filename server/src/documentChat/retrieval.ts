import { DETECTED_DOCUMENT_TYPES, UNDERSTANDING_FIELDS, documentLabel, isUnderstandingType } from '@tajir/shared';
import type { Repositories } from '../repositories/types.js';

/** A piece of one of the user's own documents, chosen because it looks relevant to a question. */
export interface RetrievedChunk {
  documentId: string;
  /** The file name the user knows it by. */
  documentName: string;
  page?: number;
  text: string;
  score: number;
  /** "text" is words from the document; "facts" is the checked details read from it. */
  kind: 'text' | 'facts';
}

export interface RetrieveOptions {
  /** Only look in these documents (still only the user's own). */
  documentIds?: string[];
  /** How many pieces to return at most. */
  maxChunks?: number;
  /** The longest a returned piece may be. Longer ones are cut. */
  maxChunkChars?: number;
}

/**
 * Finds the pieces of a user's documents that bear on a question. It is a seam: today it scores words in MongoDB-stored
 * text; to use Atlas Vector Search later, implement this interface and swap it in. Callers never depend on how.
 * Only the given user's documents are ever searched.
 */
export interface Retriever {
  retrieve(userId: string, question: string, options?: RetrieveOptions): Promise<RetrievedChunk[]>;
  /**
   * The start of each document, for questions that are about a whole document ("what does it contain", "summarise",
   * "compare") and so have no word to search for. Details read from the document come first, then its opening text.
   * At most `maxPieces` pieces in all, spread over the documents.
   */
  overview(userId: string, options?: { documentIds?: string[]; maxDocuments?: number; maxPieces?: number; maxChunkChars?: number }): Promise<RetrievedChunk[]>;
}

const STOP = new Set(
  'a an the is are was were be been am do does did have has had i me my mine we you your it its this that these those of in on at for to from by with about and or but if then so as not please can could would should will what which when where who whom how tell show give find read check list say get any some all there their them they he she his her our us file files document documents doc docs pdf upload uploaded uploading scan copy'.split(' '),
);

const SYNONYMS: Record<string, string> = {
  license: 'licence',
  licenses: 'licence',
  licences: 'licence',
  expire: 'expiry',
  expires: 'expiry',
  expiring: 'expiry',
  expiration: 'expiry',
  expired: 'expiry',
  passports: 'passport',
  statements: 'statement',
  numbers: 'number',
  no: 'number',
  nationality: 'nationality',
};

/** Lower-case words, with the small words dropped and a few spellings made the same. */
export function tokenise(text: string): string[] {
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words
    .filter((w) => !STOP.has(w))
    .map((w) => SYNONYMS[w] ?? (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w)));
}

const CANDIDATE_LIMIT = 3_000;

/** The checked details read from a document, as lines of text. Null when nothing was read with AI. */
function factsText(structured: Record<string, unknown> | null): string | null {
  const reading = structured as { documentType?: string; facts?: Record<string, string | string[] | null> } | null;
  if (!reading?.facts || !reading.documentType || !isUnderstandingType(reading.documentType)) return null;
  const lines = UNDERSTANDING_FIELDS[reading.documentType]
    .map((field) => {
      const value = reading.facts![field.key];
      const shown = Array.isArray(value) ? value.join(', ') : value;
      return shown ? `${field.label}: ${shown}` : null;
    })
    .filter((line): line is string => line !== null);
  return lines.length ? `Details read from this document (${DETECTED_DOCUMENT_TYPES[reading.documentType] ?? reading.documentType}):\n${lines.join('\n')}` : null;
}

export function createRetriever(repos: Repositories): Retriever {
  return {
    async overview(userId, options = {}) {
      const maxDocuments = options.maxDocuments ?? 4;
      const maxPieces = options.maxPieces ?? 6;
      const maxChars = options.maxChunkChars ?? 900;
      const wanted = options.documentIds;
      const ready = (await repos.documents.listByUser(userId, 100)).filter((d) => d.processingStatus === 'completed' || d.processingStatus === 'partially_completed');
      // The caller's order wins (the document just attached comes first); otherwise newest first.
      const chosen = (wanted ? wanted.map((id) => ready.find((d) => d.id === id)).filter((d): d is NonNullable<typeof d> => d !== undefined) : ready).slice(0, maxDocuments);
      if (chosen.length === 0) return [];
      const perDocument = Math.max(1, Math.floor(maxPieces / chosen.length));
      const [chunks, extractions] = await Promise.all([
        repos.extractions.listChunks(userId, { documentIds: chosen.map((d) => d.id), limit: 2_000 }),
        repos.extractions.listByUser(userId, 100),
      ]);
      const out: RetrievedChunk[] = [];
      for (const doc of chosen) {
        const pieces: RetrievedChunk[] = [];
        const facts = factsText(extractions.find((e) => e.documentId === doc.id)?.structured ?? null);
        if (facts) pieces.push({ documentId: doc.id, documentName: doc.originalName, text: facts, score: 1, kind: 'facts' });
        for (const chunk of chunks.filter((c) => c.documentId === doc.id)) {
          if (pieces.length >= perDocument) break;
          pieces.push({ documentId: doc.id, documentName: doc.originalName, ...(chunk.page !== undefined ? { page: chunk.page } : {}), text: chunk.text, score: 1, kind: 'text' });
        }
        out.push(...pieces.slice(0, perDocument));
      }
      return out.map((c) => ({ ...c, text: c.text.length > maxChars ? `${c.text.slice(0, maxChars)}…` : c.text }));
    },

    async retrieve(userId, question, options = {}) {
      const maxChunks = options.maxChunks ?? 6;
      const maxChars = options.maxChunkChars ?? 900;
      const queryTokens = [...new Set(tokenise(question))];
      if (queryTokens.length === 0) return [];

      // All of this is the asking user's own data: every repository call below is filtered by their id.
      const wanted = options.documentIds ? new Set(options.documentIds) : null;
      const documents = (await repos.documents.listByUser(userId, 100)).filter(
        (d) => (d.processingStatus === 'completed' || d.processingStatus === 'partially_completed') && (!wanted || wanted.has(d.id)),
      );
      if (documents.length === 0) return [];
      const byId = new Map(documents.map((d) => [d.id, d]));
      const chunks = (await repos.extractions.listChunks(userId, { documentIds: documents.map((d) => d.id), limit: CANDIDATE_LIMIT })).filter((c) => byId.has(c.documentId));
      const extractions = await repos.extractions.listByUser(userId, 100);

      interface Candidate {
        documentId: string;
        page?: number;
        text: string;
        kind: 'text' | 'facts';
      }
      const candidates: Candidate[] = chunks.map((c) => ({ documentId: c.documentId, page: c.page, text: c.text, kind: 'text' as const }));
      for (const e of extractions) {
        if (!byId.has(e.documentId)) continue;
        const reading = e.structured as { documentType?: string; facts?: Record<string, string | string[] | null> } | null;
        if (!reading?.facts || !reading.documentType || !isUnderstandingType(reading.documentType)) continue;
        const lines = UNDERSTANDING_FIELDS[reading.documentType]
          .map((field) => {
            const value = reading.facts![field.key];
            const shown = Array.isArray(value) ? value.join(', ') : value;
            return shown ? `${field.label}: ${shown}` : null;
          })
          .filter((line): line is string => line !== null);
        if (lines.length) candidates.push({ documentId: e.documentId, text: `Details read from this document (${DETECTED_DOCUMENT_TYPES[reading.documentType] ?? reading.documentType}):\n${lines.join('\n')}`, kind: 'facts' });
      }

      // Words that few pieces contain count for more than words that nearly all of them contain.
      const tokenised = candidates.map((c) => tokenise(c.text));
      const documentFrequency = new Map<string, number>();
      for (const tokens of tokenised) for (const t of new Set(tokens)) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);

      const scored = candidates.map((candidate, index) => {
        const doc = byId.get(candidate.documentId)!;
        const nameTokens = new Set(tokenise(`${doc.originalName} ${documentLabel(doc.typeId)} ${doc.detectedType ?? ''}`));
        const counts = new Map<string, number>();
        for (const t of tokenised[index]!) counts.set(t, (counts.get(t) ?? 0) + 1);
        let score = 0;
        for (const token of queryTokens) {
          const tf = counts.get(token) ?? 0;
          if (tf > 0) score += Math.log(1 + candidates.length / (1 + (documentFrequency.get(token) ?? 0))) * (1 + Math.min(tf, 3) * 0.3);
          if (nameTokens.has(token)) score += 1.5;
        }
        // The checked details are more reliable than raw text, so they win a tie.
        if (candidate.kind === 'facts' && score > 0) score += 0.5;
        return { candidate, doc, score, index };
      });

      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, maxChunks)
        .map(({ candidate, doc, score }) => ({
          documentId: doc.id,
          documentName: doc.originalName,
          ...(candidate.page !== undefined ? { page: candidate.page } : {}),
          text: candidate.text.length > maxChars ? `${candidate.text.slice(0, maxChars)}…` : candidate.text,
          score,
          kind: candidate.kind,
        }));
    },
  };
}
