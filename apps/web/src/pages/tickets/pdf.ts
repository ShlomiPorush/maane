// pdf.js for the PDF preview (requirements 3.2), loaded only when a PDF preview opens, so the rest of the UI never
// carries it. Its worker is a file Vite emits from pdfjs-dist into the build, served from Maane's own origin, so the
// UI's policy (script-src 'self', no 'unsafe-eval') covers it with no exception. pdf.js renders pages to a canvas only:
// no viewer, no annotation or form layer, and no scripting (the scripting sandbox, pdf.sandbox.mjs, is never loaded).
//
// Images in JBIG2 and CCITT (scans, faxes) and JPEG 2000 need pdf.js's own decoders. The build serves the JavaScript
// form pdfjs-dist ships for them (vite.config.ts, pdfDecoders) under DECODERS, the documented `wasmUrl`, and
// `useWasm: false` makes pdf.js load that form: plain JavaScript (wasm2js output, no eval), so the policy needs no
// 'wasm-unsafe-eval'. pdfjs-dist 6 has no `isEvalSupported` option any more: it never compiles code at run time, and
// the policy forbids eval anyway.
//
// An image pdf.js cannot decode does not fail the page (not even with `stopAtErrors`): pdf.js leaves it out and the
// image object it keeps for the page resolves to nothing. After a page is drawn, missingImages reads the page's
// operator list (getOperatorList, OPS) and its image objects (`objs`, `commonObjs`, PDFObjects.get), all typed and
// documented in pdfjs-dist, so the preview can say that part of the page is missing instead of showing it silently
// incomplete.

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist"

/** Where the build serves pdf.js's decoders (PDF_DECODERS in vite.config.ts), from the site's root. */
const DECODERS = "/pdfjs/"

export async function openPdf(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    wasmUrl: DECODERS,
    enableXfa: false,
    // Fonts the file does not embed are drawn with the system's; nothing is fetched for them.
    useSystemFonts: true,
  }).promise
}

/** How many images a drawn page paints that pdf.js could not decode (their objects resolved to nothing). */
export async function missingImages(page: PDFPageProxy): Promise<number> {
  const { OPS } = await import("pdfjs-dist")
  const list = await page.getOperatorList()
  let missing = 0
  list.fnArray.forEach((fn, index) => {
    if (fn !== OPS.paintImageXObject && fn !== OPS.paintImageXObjectRepeat) return
    const id = list.argsArray[index]?.[0]
    if (typeof id !== "string") return
    // Images shared across pages live in the document's common objects (their IDs start with "g_").
    const store = id.startsWith("g_") ? page.commonObjs : page.objs
    try {
      if (!store.has(id) || !store.get(id)) missing++
    } catch {
      missing++
    }
  })
  return missing
}
