// A file's preview in the shared dialog (requirements 3.2): an image as an <img> of its preview address, a PDF drawn
// by pdf.js on a canvas page by page (with a note when part of a page cannot be drawn), a text as plain text (each line
// with its own direction). The server serves a preview only for a clean file of one of these types, read from its
// content; anything else never opens here.

import { type AttachmentView, TEXT_PREVIEW_MAX_BYTES } from "@maane/shared"
import { ChevronLeft, ChevronRight, Download } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { requestFile } from "../../api/client.ts"
import { downloadUrl, previewUrl } from "../../api/endpoints.ts"
import { errorText } from "../../api/errors.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { Dialog } from "../../ui/Dialog.tsx"
import { Banner, Loading } from "../../ui/states.tsx"

export function FilePreview({ file, onClose }: { file: AttachmentView; onClose: () => void }) {
  const { t } = useI18n()
  const name = file.fileName ?? t("ticket.noFileName")
  return (
    <Dialog
      title={t("ticket.previewTitle", { name })}
      size={file.preview === "text" ? "md" : "wide"}
      onClose={onClose}
      backdropClose
      foot={
        <a className="ui-btn" href={downloadUrl(file.id)} download>
          <Download aria-hidden="true" />
          {t("ticket.download")}
        </a>
      }
    >
      <div className="ui-preview" data-preview={file.preview ?? ""}>
        {file.preview === "image" ? <img className="ui-preview-image" src={previewUrl(file.id)} alt={name} /> : null}
        {file.preview === "pdf" ? <PdfPreview id={file.id} /> : null}
        {file.preview === "text" ? <TextPreview id={file.id} size={file.size} /> : null}
      </div>
    </Dialog>
  )
}

function TextPreview({ id, size }: { id: string; size: number }) {
  const { t } = useI18n()
  const [state, setState] = useState<{ text: string } | { error: string } | null>(null)
  const tooLarge = size > TEXT_PREVIEW_MAX_BYTES
  useEffect(() => {
    if (tooLarge) return
    let gone = false
    requestFile(previewUrl(id))
      .then((response) => response.text())
      .then(
        (text) => !gone && setState({ text }),
        (error: unknown) => !gone && setState({ error: errorText(t, error) }),
      )
    return () => {
      gone = true
    }
  }, [id, tooLarge, t])
  if (tooLarge) return <p className="ui-hint">{t("ticket.previewTooLarge")}</p>
  if (!state) return <Loading label={t("ticket.previewLoading")} />
  if ("error" in state) return <PreviewError text={state.error} />
  return <pre className="ui-preview-text">{state.text}</pre>
}

function PreviewError({ text }: { text: string }) {
  const { t } = useI18n()
  return (
    <div className="ui-empty ui-error" role="alert">
      <b>{t("ticket.previewFailed")}</b>
      <span>{text}</span>
    </div>
  )
}

type Pdf = import("pdfjs-dist").PDFDocumentProxy

type PdfState =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; document: Pdf; pages: number }

function PdfPreview({ id }: { id: string }) {
  const { t } = useI18n()
  const canvas = useRef<HTMLCanvasElement>(null)
  const [state, setState] = useState<PdfState>({ status: "loading" })
  const [page, setPage] = useState(1)
  // Pages pdf.js could not draw in full: they show what it could, and a note says part is missing.
  const [partial, setPartial] = useState<ReadonlySet<number>>(new Set())

  useEffect(() => {
    let gone = false
    const opened: Promise<Pdf>[] = []
    ;(async () => {
      try {
        const data = await (await requestFile(previewUrl(id))).arrayBuffer()
        const { openPdf } = await import("./pdf.ts")
        const loading = openPdf(data)
        opened.push(loading)
        const document = await loading
        if (gone) return
        setState({ status: "ready", document, pages: document.numPages })
      } catch (error) {
        if (!gone) setState({ status: "failed", error: errorText(t, error) })
      }
    })()
    return () => {
      gone = true
      for (const document of opened) void document.then((pdf) => pdf.loadingTask.destroy()).catch(() => undefined)
    }
  }, [id, t])

  useEffect(() => {
    if (state.status !== "ready" || !canvas.current) return
    const target = canvas.current
    let task: import("pdfjs-dist").RenderTask | null = null
    let gone = false
    const draw = async (document: Pdf) => {
      const pdfPage = await document.getPage(page)
      if (gone) return
      // Fit the page to the dialog's width, drawn at the screen's pixel density.
      const width = Math.max(240, target.parentElement?.clientWidth ?? 800)
      const base = pdfPage.getViewport({ scale: 1 })
      const scale = Math.min(2, width / base.width)
      const ratio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: scale * ratio })
      target.width = Math.floor(viewport.width)
      target.height = Math.floor(viewport.height)
      target.style.width = `${Math.floor(viewport.width / ratio)}px`
      task = pdfPage.render({ canvas: target, viewport })
      await task.promise
      return pdfPage
    }
    const cancelled = (error: unknown) => (error as { name?: string }).name === "RenderingCancelledException"
    ;(async () => {
      try {
        const drawn = await draw(state.document)
        if (gone || !drawn) return
        target.dataset.rendered = String(page)
        // An image pdf.js could not decode leaves part of the page out: say so.
        const { missingImages } = await import("./pdf.ts")
        if (!gone && (await missingImages(drawn)) > 0) setPartial((pages) => new Set(pages).add(page))
      } catch (error) {
        if (!gone && !cancelled(error)) setState({ status: "failed", error: errorText(t, error) })
      }
    })()
    return () => {
      gone = true
      task?.cancel()
    }
  }, [state, page, t])

  if (state.status === "loading") return <Loading label={t("ticket.previewLoading")} />
  if (state.status === "failed") return <PreviewError text={state.error} />
  return (
    <div className="ui-pdf">
      {state.pages > 1 ? (
        <div className="ui-pdf-nav">
          <button
            type="button"
            className="ui-icon-btn ui-pdf-prev"
            aria-label={t("ticket.pdfPrevious")}
            title={t("ticket.pdfPrevious")}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <span className="ui-pdf-page">{t("ticket.pdfPage", { page, pages: state.pages })}</span>
          <button
            type="button"
            className="ui-icon-btn ui-pdf-next"
            aria-label={t("ticket.pdfNext")}
            title={t("ticket.pdfNext")}
            disabled={page >= state.pages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
      ) : (
        <span className="ui-pdf-page">{t("ticket.pdfPage", { page, pages: state.pages })}</span>
      )}
      {partial.has(page) ? (
        <div className="ui-pdf-partial" data-testid="pdf-partial">
          <Banner tone="warn" title={t("ticket.pdfPartial")}>
            {t("ticket.pdfPartialHint")}
          </Banner>
        </div>
      ) : null}
      <div className="ui-pdf-page-frame">
        <canvas ref={canvas} className="ui-pdf-canvas" data-testid="pdf-canvas" />
      </div>
    </div>
  )
}
