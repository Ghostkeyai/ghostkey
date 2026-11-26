// Baca teks PDF di browser ini (pdf.js, disajikan dari domain kita sendiri — tanpa CDN, tanpa layanan OCR).
// Berkasnya tidak pernah diunggah: yang ikut pesan hanya teks hasil ekstraksi, bisa dilihat di "What we sent".
const BASE = '/js/vendor/pdfjs/';
export const MAX_BYTES = 30 * 1024 * 1024;   // berkas lebih besar dari ini biasanya hasil pindai gambar
export const MAX_PAGES = 400;
let lib = null;

async function pdfjs() {
  if (lib) return lib;
  lib = await import(BASE + 'pdf.min.mjs');
  lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.mjs';
  return lib;
}

// Satu halaman → teks; baris baru mengikuti tanda akhir-baris pdf.js
function pageText(items) {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    s += it.hasEOL ? '\n' : (it.str && !it.str.endsWith(' ') ? ' ' : '');
  }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * readPdf(file, onProgress(i, n)) → { name, pages, text, chars, emptyPages }
 * Galat yang dilempar memakai e.code: not_pdf · too_big · locked · no_text · broken
 */
export async function readPdf(file, onProgress = () => {}) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!file) throw fail('broken');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  if (!isPdf) throw fail('not_pdf');
  if (file.size > MAX_BYTES) throw fail('too_big');
  const data = new Uint8Array(await file.arrayBuffer());
  const head = String.fromCharCode(...data.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw fail('not_pdf');
  const { getDocument } = await pdfjs();
  let doc;
  try {
    doc = await getDocument({
      data, cMapUrl: BASE + 'cmaps/', cMapPacked: true,
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, enableXfa: false,
      disableAutoFetch: true, disableStream: true,
    }).promise;
  } catch (e) {
    throw fail(e?.name === 'PasswordException' ? 'locked' : 'broken');
  }
  try {
    const n = Math.min(doc.numPages, MAX_PAGES);
    const parts = [];
    let emptyPages = 0;
    for (let i = 1; i <= n; i++) {
      onProgress(i, n);
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const t = pageText(tc.items);
      if (!t) emptyPages++;
      parts.push(`[page ${i}]\n${t || '(no text on this page)'}`);
      page.cleanup();
    }
    if (emptyPages === n) throw fail('no_text');
    const text = parts.join('\n\n');
    return { name: (file.name || 'document.pdf').slice(0, 120), pages: n, totalPages: doc.numPages, text, chars: text.length, emptyPages };
  } finally {
    doc.destroy();
  }
}

// Perkiraan token kasar (≈4 karakter per token untuk teks Inggris); struk tetap memakai angka OpenRouter.
export const estTokens = (chars) => Math.ceil(chars / 4);

// Bentuk isi pesan: dokumen dulu, lalu pertanyaan pengguna
export function docMessage(doc, ask) {
  const name = doc.name.replace(/"/g, "'");
  return `<document name="${name}" pages="${doc.pages}">\n${doc.text}\n</document>\n\n${ask}`;
}

export const ERR_TEXT = {
  not_pdf: 'That file is not a PDF. Only PDFs can be attached for now.',
  too_big: 'That PDF is over 30 MB, which usually means it is scanned images. Attach a smaller file.',
  locked: 'This PDF is password-protected. Open it, save an unlocked copy, and attach that.',
  no_text: 'This PDF has no text layer. It looks like a scan. We do not send files to an OCR service, so there is nothing to read here.',
  broken: 'This PDF could not be read. It may be damaged. Try saving it again from the app that made it.',
};
