import type { PDFDocumentLoadingTask } from "pdfjs-dist"

const DECODERS = "/pdfjs/"

export type PdfJs = typeof import("pdfjs-dist")

export async function loadPdfJs(): Promise<PdfJs> {
  const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")])
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

export function openPdf(pdfjs: PdfJs, data: ArrayBuffer): PDFDocumentLoadingTask {
  return pdfjs.getDocument({
    data: new Uint8Array(data),
    useWasm: false,
    wasmUrl: DECODERS,
    enableXfa: false,
    useSystemFonts: true,
  })
}
