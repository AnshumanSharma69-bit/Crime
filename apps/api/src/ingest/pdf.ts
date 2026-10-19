import { extractText, getDocumentProxy } from 'unpdf';

export const MAX_PDF_BYTES = 10 * 1024 * 1024; const MAX_PAGES = 30; const MAX_CHARS = 20_000;
/** Selectable-text PDFs only. Scanned images yield no text; OCR is not implemented. */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  if (bytes.length > MAX_PDF_BYTES) throw new Error('pdf_too_large');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  if (pdf.numPages > MAX_PAGES) throw new Error('pdf_too_many_pages');
  const { text } = await extractText(pdf, { mergePages: true });
  const t = (Array.isArray(text) ? text.join('\n') : text).trim().slice(0, MAX_CHARS);
  if (t.length < 20) throw new Error('pdf_no_text');
  return { text: t, pages: pdf.numPages };
}
