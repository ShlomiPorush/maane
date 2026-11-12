// pdf.js for the PDF preview (requirements 3.2), loaded only when a PDF preview opens, so the rest of the UI never
// carries it. Its worker is a file Vite emits from pdfjs-dist into the build, served from Maane's own origin, so the
// UI's policy (script-src 'self', no 'unsafe-eval') covers it with no exception. pdf.js renders pages to a canvas only:
// no viewer, no annotation or form layer, and no scripting (the scripting sandbox, pdf.sandbox.mjs, is never loaded).
// WebAssembly stays off (`useWasm: false`), so the policy needs no 'wasm-unsafe-eval'; a JPEG 2000 image inside a PDF
// does not render then. pdfjs-dist 6 has no `isEvalSupported` option any more: it never compiles code at run time, and
// the policy forbids eval anyway.

import type { PDFDocumentProxy } from "pdfjs-dist"

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    enableXfa: false,
    // Fonts the file does not embed are drawn with the system's; nothing is fetched for them.
    useSystemFonts: true,
  }).promise
}
