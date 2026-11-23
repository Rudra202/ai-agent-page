/** The most text kept for one document. Longer documents are cut, and the record says so. */
export const MAX_TEXT_CHARS = 200_000;
export const MAX_CHUNKS = 400;

/**
 * Cleans text read from a file: one Unicode form, no control characters (a NUL or an escape code has no business in
 * stored text), consistent line breaks, and no runs of blank space. The words themselves are never changed.
 */
export function normaliseText(raw: string): string {
  return (
    raw
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t   ]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Letters and digits only: what counts as "text was really read", not stray marks. */
export const meaningfulLength = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

export interface PageText {
  /** 1-based. */
  page: number;
  text: string;
}

export interface TextChunk {
  text: string;
  page?: number;
}

function splitLong(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    // Prefer to cut after a sentence, then at a space, and only then in the middle of a word.
    const window = rest.slice(0, size);
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
    const space = window.lastIndexOf(' ');
    const cut = sentence > size * 0.5 ? sentence + 1 : space > size * 0.5 ? space : size;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/**
 * Splits page text into pieces small enough to search and to quote, each remembering its page. Pieces follow
 * paragraph breaks where possible, and a little of the previous piece is repeated at the start of the next so a
 * sentence cut at the boundary is still found.
 */
export function chunkPages(pages: PageText[], size = 1_000, overlap = 150): TextChunk[] {
  const chunks: TextChunk[] = [];
  for (const { page, text } of pages) {
    const paragraphs = text
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .flatMap((p) => splitLong(p, size));
    let current = '';
    const flush = () => {
      const trimmed = current.trim();
      if (trimmed) chunks.push({ text: trimmed, page });
      // Carry the end of this piece into the next one, on a word boundary.
      const tail = trimmed.slice(-overlap);
      current = trimmed.length > overlap ? tail.slice(tail.indexOf(' ') + 1) : '';
    };
    for (const paragraph of paragraphs) {
      if (current && current.length + paragraph.length + 2 > size) flush();
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    // The last piece of a page: keep it only if it holds something beyond the overlap already stored.
    if (current.trim() && (chunks.at(-1)?.page !== page || !chunks.at(-1)!.text.endsWith(current.trim()))) {
      chunks.push({ text: current.trim(), page });
    }
    if (chunks.length >= MAX_CHUNKS) break;
  }
  return chunks.slice(0, MAX_CHUNKS);
}
