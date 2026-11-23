import { createCanvas } from '@napi-rs/canvas';

/**
 * Real files for tests, made on the spot: PDFs with text, PDFs that are only a picture of text (a "scan"), and
 * images of text. Nothing here is a mock: the extraction code reads these exactly as it reads an upload.
 */

const escapePdf = (text: string) => text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export interface PdfPage {
  /** Lines of real, selectable text. */
  lines?: string[];
  /** A picture covering the whole page (a scan). */
  image?: { data: Buffer; width: number; height: number };
}

/** A valid PDF with correct cross-reference offsets. */
export function buildPdf(pages: PdfPage[], extraCatalog = ''): Buffer {
  const objects: Buffer[] = [];
  const add = (body: string | Buffer): number => {
    objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    return objects.length;
  };
  // Reserve 1 (catalog), 2 (pages) and 3 (font) and fill 1 and 2 in at the end.
  add('');
  add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const page of pages) {
    let imageId = 0;
    if (page.image) {
      const head = Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.data.length} >>\nstream\n`, 'latin1');
      imageId = add(Buffer.concat([head, page.image.data, Buffer.from('\nendstream', 'latin1')]));
    }
    const content = page.image
      ? 'q 595 0 0 842 0 0 cm /Im0 Do Q'
      : `BT /F1 14 Tf 50 780 Td 20 TL ${(page.lines ?? []).map((line) => `(${escapePdf(line)}) Tj T*`).join(' ')} ET`;
    const contentId = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    const resources = `<< /Font << /F1 ${font} 0 R >>${imageId ? ` /XObject << /Im0 ${imageId} 0 R >>` : ''} >>`;
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${contentId} 0 R >>`));
  }
  objects[0] = Buffer.from(`<< /Type /Catalog /Pages 2 0 R ${extraCatalog} >>`, 'latin1');
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let position = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(position);
    const piece = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(piece);
    position += piece.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`, 'latin1'));
  return Buffer.concat(parts);
}

/** Draws lines of large dark text on white, like a clean scan. */
export function renderText(lines: string[], { width = 1654, height = 2339, format = 'png' as 'png' | 'jpeg' } = {}): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#000000';
  context.font = '54px sans-serif';
  lines.forEach((line, index) => context.fillText(line, 100, 160 + index * 90));
  return format === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', 90);
}

/** A PDF that is only a picture of text: it has no text layer, so reading it needs OCR. */
export function scannedPdf(lines: string[], pages = 1): Buffer {
  const jpeg = renderText(lines, { format: 'jpeg' });
  return buildPdf(Array.from({ length: pages }, () => ({ image: { data: jpeg, width: 1654, height: 2339 } })));
}

/** A white image with nothing on it. */
export function blankPng(width = 800, height = 600): Buffer {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  return canvas.toBuffer('image/png');
}

export const TRADE_LICENCE_LINES = [
  'TRADE LICENCE',
  'Licence No: 1234567',
  'Company Name: Vinith Media FZ LLC',
  'Legal Form: Free Zone Limited Liability',
  'Business Activity: Marketing Consultancy',
  'Issue Date: 01/02/2026',
  'Expiry Date: 31/01/2027',
];
