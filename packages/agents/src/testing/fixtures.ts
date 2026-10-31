/**
 * Test fixtures: tiny, valid documents and images generated in memory. FIXTURES ONLY: never real data.
 */
import type { DocumentInput } from '../tools/documents';
import type { ImageInput } from '../tools/images';

/** A minimal but valid multi-page PDF with one line of text per page. */
export function buildPdf(pages: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  pages.forEach((text, i) => {
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + i * 2} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    const stream = `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\r\nstream\r\n${stream}\r\nendstream`);
  });
  // CRLF everywhere, offsets counted on the same string (pdf.js 1.10, used by pdf-parse, is picky).
  let out = '%PDF-1.4\r\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\r\n${body}\r\nendobj\r\n`;
  });
  const xref = out.length;
  out += `xref\r\n0 ${objs.length + 1}\r\n0000000000 65535 f\r\n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n\r\n`).join('')}`;
  out += `trailer\r\n<< /Size ${objs.length + 1} /Root 1 0 R >>\r\nstartxref\r\n${xref}\r\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

/** A minimal valid .docx whose paragraphs are `paragraphs`. `withMacros` adds a vbaProject.bin entry. */
export async function buildDocx(paragraphs: string[], opts: { withMacros?: boolean } = {}): Promise<Buffer> {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  if (opts.withMacros) zip.file('word/vbaProject.bin', 'FAKE-MACRO-BYTES');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A solid-colour PNG. */
export async function makePng(width: number, height: number, color: string, opts: { withExif?: boolean } = {}): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  let img = sharp({ create: { width, height, channels: 3, background: color } });
  if (opts.withExif) img = img.withExif({ IFD0: { Copyright: 'FIXTURE-EXIF-MARKER' } });
  return img.png().toBuffer();
}

export const docInput = (name: string, data: Buffer, mimeType = 'application/octet-stream'): DocumentInput => ({ name, mimeType, size: data.length, load: async () => data });
export const imageInput = (name: string, data: Buffer, kind = 'logo', mimeType = 'image/png'): ImageInput => ({ name, kind, mimeType, size: data.length, load: async () => data });
