// pdf.js for the PDF preview (requirements 3.2), loaded only when a PDF preview opens, so the rest of the UI never
// carries it. Its worker is a file Vite emits from pdfjs-dist into the build, served from Maane's own origin, so the
// UI's policy (script-src 'self', no 'unsafe-eval') covers it with no exception. pdf.js renders pages to a canvas only:
// no viewer, no annotation or form layer, and no scripting (the scripting sandbox, pdf.sandbox.mjs, is never loaded).
//
// Images in JBIG2 and CCITT (scans, faxes) and JPEG 2000 need pdf.js's own decoders. Vite serves the JavaScript form
// pdfjs-dist ships for them (vite.config.ts, pdfDecoders, in the build and in the dev server) under DECODERS, the
// documented `wasmUrl`, and `useWasm: false` makes pdf.js load that form: plain JavaScript (wasm2js output, no eval),
// so the policy needs no 'wasm-unsafe-eval'. pdfjs-dist 6 has no `isEvalSupported` option any more: it never compiles
// code at run time, and the policy forbids eval anyway.
//
// pdf.js documents no way to learn that it left part of a page out (an image it cannot decode is skipped), so the
// preview always says, in one short note, that the download holds the original.

import type { PDFDocumentLoadingTask } from "pdfjs-dist"

/** Where Vite serves pdf.js's decoders (PDF_DECODERS in vite.config.ts), from the site's root. */
const DECODERS = "/pdfjs/"

export type PdfJs = typeof import("pdfjs-dist")

/** Loads pdf.js and points it at its worker. Nothing starts yet: the caller decides whether a document still opens. */
export async function loadPdfJs(): Promise<PdfJs> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/**
 * Starts loading a document, at once: the caller checks that the preview is still open right before, and owns the
 * loading task from this moment. Destroying it ends the document and its worker, also while it still loads.
 */
export function openPdf(pdfjs: PdfJs, data: ArrayBuffer): PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    wasmUrl: DECODERS,
    enableXfa: false,
    // Fonts the file does not embed are drawn with the system's; nothing is fetched for them.
    useSystemFonts: true,
  })
}
