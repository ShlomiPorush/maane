// The composer of a ticket (plan 3.1): a reply or an internal note. To and Cc start from the ticket's participants,
// From from the organization's support addresses (the ticket's own first), and the text is written in TipTap, where
// each paragraph takes the direction of its first letter (its documented textDirection: "auto"). Files come from the
// agent's computer (uploaded, then scanned by the worker; a refused one says why and is never sent) or from the
// ticket's own messages. One click is one message: the composer sends a submission ID, kept until the server answers,
// so a repeated or lost request finds the same message. While intake listens, only internal notes can be written.
// A reply's default action is "Send and set pending" (plan 4.1): the server sets the status in the reply's own
// transaction; "Send" leaves the status. A closed ticket offers only "Send" to an agent (only an admin leaves closed).
// "Send later" (plan 4.2) schedules the reply for a date and time in Israel time, with its status action, which applies
// when it goes. A scheduled reply its author changes comes back into the composer; saving makes a new version.
// TipTap's own stylesheet stays off (injectCSS: false): the UI's policy allows no inline <style>; ui.css styles it.

import {
  type AttachmentView,
  type ComposeView,
  type MailAddress,
  mayChangeStatus,
  type ReplyInput,
  type ScheduledReplyView,
  type TicketView,
  type UploadView,
} from "@maane/shared"
import { useQueryClient } from "@tanstack/react-query"
import { EditorContent, useEditor, useEditorState } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import { Bold, CalendarClock, Italic, List, ListOrdered, Paperclip, Quote, Send, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { ApiError } from "../../api/client.ts"
import { api, qk } from "../../api/endpoints.ts"
import { errorText } from "../../api/errors.ts"
import { formatTime } from "../../format/datetime.ts"
import { formatBytes } from "../../format/number.ts"
import { useI18n } from "../../i18n/i18n.tsx"
import { useMe } from "../../shell/session.ts"
import { confirmDialog } from "../../ui/confirm.tsx"
import { Banner } from "../../ui/states.tsx"
import { showToast } from "../../ui/Toast.tsx"
import { Tag, type Tone } from "../../ui/tags.tsx"
import { useUnsaved } from "../../ui/unsaved.tsx"
import { FormError } from "../auth/parts.tsx"
import { WhenDialog } from "./When.tsx"

/** How often an upload's scan is read, and how long the composer waits for it. */
const SCAN_POLL_MS = 1_500
const SCAN_WAIT_MS = 5 * 60_000

type Kind = "reply" | "note"

/** A file the agent added: an upload on its way or scanned, or a file of the ticket's own messages. */
type Picked =
  | { key: string; source: "upload"; name: string; size: number; upload: UploadView | null; failed: string | null }
  | { key: string; source: "part"; name: string; size: number; part: AttachmentView }

const UPLOAD_TONE: Record<UploadView["status"], Tone> = {
  scanning: "info",
  clean: "ok",
  not_fully_scanned: "warn",
  not_scanned: "warn",
  infected: "fail",
  blocked_type: "fail",
  too_large: "fail",
  scanner_unavailable: "fail",
}
const ATTACHABLE = new Set(["clean", "not_fully_scanned", "not_scanned"])

/** Addresses typed into To or Cc: separated by commas, semicolons, or spaces; names come from the participants. */
export function parseAddresses(text: string, known: MailAddress[]): MailAddress[] {
  const names = new Map(known.map((entry) => [entry.address.toLowerCase(), entry.name]))
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim().replace(/^<|>$/g, "").toLowerCase())
    .filter(Boolean)
    .map((address) => ({ address, name: names.get(address) ?? null }))
}

const listText = (list: MailAddress[]) => list.map((entry) => entry.address).join(", ")

/** A scheduled reply's file as the composer holds it again (its upload was scanned and kept when it was written). */
function pickedOf(file: ScheduledReplyView["files"][number]): Picked {
  if (file.source === "upload")
    return {
      key: file.id,
      source: "upload",
      name: file.fileName,
      size: file.size,
      upload: {
        id: file.id,
        fileName: file.fileName,
        size: file.size,
        status: "clean",
        signature: null,
        blockedBy: null,
      },
      failed: null,
    }
  return {
    key: file.id,
    source: "part",
    name: file.fileName,
    size: file.size,
    part: {
      id: file.id,
      kind: "attachment",
      fileName: file.fileName,
      size: file.size,
      status: "clean",
      signature: null,
      blockedBy: null,
      unavailableReason: null,
      detectedType: null,
      preview: null,
      download: true,
    },
  }
}

export function Composer({
  view,
  editing = null,
  onEditDone = () => {},
  onEditKeep = () => {},
}: {
  view: TicketView
  /** A scheduled reply its author is changing (plan 4.2), loaded into the composer. */
  editing?: ScheduledReplyView | null
  onEditDone?: () => void
  /** The agent kept changing this reply rather than load another one in its place. */
  onEditKeep?: (scheduled: ScheduledReplyView) => void
}) {
  const { t } = useI18n()
  const compose = view.compose
  const queryClient = useQueryClient()
  const formId = useId()
  const [kind, setKind] = useState<Kind>(compose.listening ? "note" : "reply")
  const [chosenFrom, setFrom] = useState(compose.defaultFrom ?? "")
  // A From the ticket no longer offers (it moved to another organization) gives way to its default; the draft stays.
  const from = compose.from.includes(chosenFrom) ? chosenFrom : (compose.defaultFrom ?? "")
  const [to, setTo] = useState(listText(compose.to))
  const [cc, setCc] = useState(listText(compose.cc))
  const [files, setFiles] = useState<Picked[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [empty, setEmpty] = useState(true)
  const submission = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  // Intake switched to listening while the composer was open: only a note can go now.
  useEffect(() => {
    if (compose.listening) setKind("note")
  }, [compose.listening])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
      }),
    ],
    textDirection: "auto",
    injectCSS: false,
    editorProps: {
      attributes: {
        class: "ui-editor-text",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t("compose.text"),
        "data-testid": "composer-text",
      },
    },
    onUpdate: ({ editor: current }) => setEmpty(current.isEmpty),
  })
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive("bold") ?? false,
      italic: current?.isActive("italic") ?? false,
      bulletList: current?.isActive("bulletList") ?? false,
      orderedList: current?.isActive("orderedList") ?? false,
      blockquote: current?.isActive("blockquote") ?? false,
    }),
  })

  const dirty = !empty || files.length > 0
  useUnsaved("composer", { count: dirty ? 1 : 0, kind: "leave" })
  const [later, setLater] = useState(false)
  const role = useMe().data?.role ?? "agent"
  // "Send and set pending" only where this user may set pending (not on a closed ticket, unless an admin).
  const canSetPending = mayChangeStatus(role, view.ticket.status, "pending")
  const [laterPending, setLaterPending] = useState(canSetPending)

  const clear = () => {
    editor?.commands.clearContent()
    setEmpty(true)
    setFiles([])
  }

  // A scheduled reply to change comes into the composer; a draft in it is dropped only when the agent agrees. The change
  // is pinned to the reply and the version its content was loaded from until the agent saves or stops: a newer view
  // never moves it, and a reply that went out or was cancelled meanwhile gets the server's refusal on save, never a new
  // reply in its place.
  const loaded = useRef<{ id: string; version: number } | null>(null)
  // The reply being changed as it was loaded, and its fields as the composer held them then: a change to another
  // scheduled reply asks first when any of them was edited since.
  const loadedView = useRef<ScheduledReplyView | null>(null)
  const baseline = useRef("")
  const fields = () =>
    JSON.stringify([editor?.getHTML() ?? "", chosenFrom, to, cc, files.map((file) => file.key), laterPending])
  const draft = useRef(false)
  draft.current = loaded.current === null ? dirty : fields() !== baseline.current
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per scheduled reply chosen
  useEffect(() => {
    if (!editor || !editing || loaded.current?.id === editing.id) return
    const load = async () => {
      if (draft.current) {
        const yes = await confirmDialog({
          title: t("unsaved.discardTitle"),
          message: t("compose.replaceDraft"),
          confirmText: t("unsaved.discard"),
          cancelText: t("unsaved.keepEditing"),
          focusCancel: true,
        })
        if (!yes) {
          // The change in progress stays; with none, the composer keeps its draft.
          if (loadedView.current) onEditKeep(loadedView.current)
          else onEditDone()
          return
        }
      }
      if (!mounted.current) return
      loaded.current = { id: editing.id, version: editing.version }
      loadedView.current = editing
      setKind("reply")
      setFrom(editing.from)
      setTo(listText(editing.to))
      setCc(listText(editing.cc))
      setFiles(editing.files.map(pickedOf))
      setLaterPending(editing.setPending && canSetPending)
      editor.commands.setContent(editing.html)
      setEmpty(editor.isEmpty)
      setError(null)
      baseline.current = JSON.stringify([
        editor.getHTML(),
        editing.from,
        listText(editing.to),
        listText(editing.cc),
        editing.files.map((file) => file.id),
        editing.setPending && canSetPending,
      ])
      editor.commands.focus()
    }
    void load()
  }, [editor, editing?.id])

  const stopEditing = () => {
    loaded.current = null
    loadedView.current = null
    clear()
    setTo(listText(compose.to))
    setCc(listText(compose.cc))
    onEditDone()
  }

  const scanning = files.some((file) => file.source === "upload" && (!file.upload || file.upload.status === "scanning"))
  const sendable = files.filter(
    (file) => file.source === "part" || (file.upload !== null && ATTACHABLE.has(file.upload.status)),
  )

  /** Uploads one file and follows its scan until the worker decided. */
  const add = async (file: File) => {
    const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`
    setFiles((current) => [
      ...current,
      { key, source: "upload", name: file.name, size: file.size, upload: null, failed: null },
    ])
    const update = (patch: { upload?: UploadView; failed?: string }) =>
      setFiles((current) => current.map((entry) => (entry.key === key ? ({ ...entry, ...patch } as Picked) : entry)))
    try {
      let state = await api.upload(file)
      update({ upload: state })
      const until = Date.now() + SCAN_WAIT_MS
      while (state.status === "scanning" && mounted.current && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_MS))
        state = await api.uploadState(state.id)
        if (mounted.current) update({ upload: state })
      }
      if (state.status === "scanning" && mounted.current) update({ failed: t("compose.scanTimeout") })
    } catch (failure) {
      if (mounted.current) update({ failed: errorText(t, failure) })
    }
  }

  const togglePart = (part: AttachmentView) =>
    setFiles((current) =>
      current.some((entry) => entry.key === part.id)
        ? current.filter((entry) => entry.key !== part.id)
        : [
            ...current,
            { key: part.id, source: "part", name: part.fileName ?? t("ticket.noFileName"), size: part.size, part },
          ],
    )

  /** What the composer holds as a request, or null (with the reason shown) when it cannot go. */
  const collect = (setPending: boolean): ReplyInput | null => {
    if (!editor) return null
    setError(null)
    if (empty && sendable.length === 0) {
      setError(t("compose.empty"))
      editor.commands.focus()
      return null
    }
    const known = [...compose.to, ...compose.cc]
    const input: ReplyInput = {
      submissionId: submission.current ?? crypto.randomUUID(),
      kind,
      from: kind === "reply" ? from : null,
      to: kind === "reply" ? parseAddresses(to, known) : [],
      cc: kind === "reply" ? parseAddresses(cc, known) : [],
      html: empty ? "" : editor.getHTML(),
      uploads: sendable.flatMap((file) => (file.source === "upload" && file.upload ? [file.upload.id] : [])),
      parts: sendable.flatMap((file) => (file.source === "part" ? [file.part.id] : [])),
      setPending: kind === "reply" && setPending,
    }
    if (kind === "reply" && input.to.length === 0) {
      setError(t("compose.toRequired"))
      return null
    }
    return input
  }

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.ticket(view.ticket.number) }),
      queryClient.invalidateQueries({ queryKey: ["tickets"] }),
    ])

  /** A submission ID is kept only while no answer came: a refusal wrote nothing, so the next click is a new one. */
  const answered = (failure: unknown) => {
    if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) submission.current = null
  }

  /** "Send later" and "Save changes": the time dialog does the request; a refusal stays in it. */
  const schedule = async (at: Date) => {
    const input = collect(laterPending && canSetPending)
    if (!input) throw new Error(t("compose.empty"))
    const target = loaded.current
    if (target) {
      const { submissionId: _submission, kind: _kind, sendAt: _sendAt, ...rest } = input
      await api.changeScheduled(target.id, { ...rest, sendAt: at.toISOString(), version: target.version })
      showToast(t("compose.scheduleChanged", { time: formatTime(at, { seconds: false }) }), "success")
      if (mounted.current) stopEditing()
    } else {
      submission.current = input.submissionId
      await api.writeMessage(view.ticket.number, { ...input, sendAt: at.toISOString() }).catch((failure: unknown) => {
        answered(failure)
        throw failure
      })
      submission.current = null
      showToast(t("compose.scheduled", { time: formatTime(at, { seconds: false }) }), "success")
      if (mounted.current) clear()
    }
    await refresh()
  }

  const openLater = () => {
    if (collect(laterPending && canSetPending)) setLater(true)
  }

  const send = async (setPending: boolean) => {
    const input = collect(setPending)
    if (!editor || !input) return
    // The same ID until the server answers: a repeated click or a retry after a lost answer finds the same message.
    submission.current = input.submissionId
    setBusy(true)
    try {
      await api.writeMessage(view.ticket.number, input)
      submission.current = null
      if (!mounted.current) return
      clear()
      showToast(
        kind === "note"
          ? t("compose.noteAdded")
          : setPending
            ? t("compose.replyQueuedPending")
            : t("compose.replyQueued"),
        "success",
      )
      await refresh()
    } catch (failure) {
      answered(failure)
      if (mounted.current) setError(errorText(t, failure))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  // Files of incoming messages and replies only: an internal note's files never reach a customer (review R1).
  const ticketFiles = view.messages.flatMap((message) =>
    message.direction === "note" ? [] : message.attachments.filter((file) => file.download),
  )
  const tool = (label: string, active: boolean, run: () => void, icon: React.ReactNode) => (
    <button
      type="button"
      className="ui-icon-btn ui-editor-tool"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={!editor || busy}
      onClick={run}
    >
      {icon}
    </button>
  )

  return (
    <section
      className="ui-panel ui-composer"
      aria-labelledby={`${formId}-title`}
      data-kind={kind}
      data-editing={editing ? editing.id : undefined}
    >
      <div className="ui-panel-head">
        <h2 id={`${formId}-title`}>{t("compose.title")}</h2>
        <fieldset className="ui-seg" aria-label={t("compose.kind")}>
          {(["reply", "note"] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-kind={option}
              aria-pressed={kind === option}
              disabled={busy || (option === "reply" && compose.listening) || (option === "note" && Boolean(editing))}
              onClick={() => setKind(option)}
            >
              {t(`compose.kinds.${option}`)}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="ui-composer-body">
        {compose.listening ? <Banner tone="info" title={t("compose.listening")} /> : null}
        {editing ? (
          <Banner
            tone="info"
            title={t("compose.editingTitle", { time: formatTime(editing.sendAt, { seconds: false }) })}
            action={
              <button type="button" className="ui-btn ui-btn-sm" disabled={busy} onClick={stopEditing}>
                {t("compose.stopEditing")}
              </button>
            }
          >
            {t("compose.editingHint")}
          </Banner>
        ) : null}
        {kind === "reply" ? (
          <ReplyFields
            compose={compose}
            formId={formId}
            from={from}
            to={to}
            cc={cc}
            busy={busy}
            onFrom={setFrom}
            onTo={setTo}
            onCc={setCc}
          />
        ) : (
          <p className="ui-composer-note">{t("compose.noteHint")}</p>
        )}
        <div className="ui-editor" data-kind={kind}>
          <div className="ui-editor-tools" role="toolbar" aria-label={t("compose.format")}>
            {tool(t("compose.bold"), marks?.bold ?? false, () => editor?.chain().focus().toggleBold().run(), <Bold />)}
            {tool(
              t("compose.italic"),
              marks?.italic ?? false,
              () => editor?.chain().focus().toggleItalic().run(),
              <Italic />,
            )}
            {tool(
              t("compose.bulletList"),
              marks?.bulletList ?? false,
              () => editor?.chain().focus().toggleBulletList().run(),
              <List />,
            )}
            {tool(
              t("compose.orderedList"),
              marks?.orderedList ?? false,
              () => editor?.chain().focus().toggleOrderedList().run(),
              <ListOrdered />,
            )}
            {tool(
              t("compose.quote"),
              marks?.blockquote ?? false,
              () => editor?.chain().focus().toggleBlockquote().run(),
              <Quote />,
            )}
          </div>
          <EditorContent editor={editor} />
        </div>
        {kind === "reply" && compose.signature ? (
          <div className="ui-composer-signature">
            <span className="ui-label">{t("compose.signature")}</span>
            <bdi dir="auto">{compose.signature}</bdi>
          </div>
        ) : null}
        {files.length > 0 ? (
          <ul className="ui-composer-files" aria-label={t("compose.files")}>
            {files.map((file) => (
              <PickedFile
                key={file.key}
                file={file}
                onRemove={() => setFiles((current) => current.filter((entry) => entry.key !== file.key))}
              />
            ))}
          </ul>
        ) : null}
        {ticketFiles.length > 0 ? (
          <details className="ui-composer-ticket-files">
            <summary>{t("compose.ticketFiles", { count: ticketFiles.length })}</summary>
            <ul>
              {ticketFiles.map((part) => (
                <li key={part.id}>
                  <label className="ui-check-label">
                    <input
                      type="checkbox"
                      className="ui-check"
                      checked={files.some((entry) => entry.key === part.id)}
                      onChange={() => togglePart(part)}
                    />
                    <bdi dir="auto">{part.fileName ?? t("ticket.noFileName")}</bdi>
                    <span className="ui-muted">{formatBytes(part.size)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {error ? <FormError>{error}</FormError> : null}
        <div className="ui-composer-acts">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              for (const file of Array.from(event.target.files ?? [])) void add(file)
              event.target.value = ""
            }}
          />
          <button type="button" className="ui-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            <Paperclip aria-hidden="true" />
            {t("compose.attach")}
          </button>
          {scanning ? <span className="ui-hint">{t("compose.waitScan")}</span> : null}
          {kind === "reply" ? (
            <button
              type="button"
              className={editing ? "ui-btn ui-btn-primary" : "ui-btn"}
              disabled={busy || scanning || !editor || compose.listening}
              onClick={openLater}
              data-testid="composer-later"
            >
              <CalendarClock aria-hidden="true" />
              {editing ? t("compose.saveChange") : t("compose.sendLater")}
            </button>
          ) : null}
          {kind === "reply" && canSetPending && !editing ? (
            <button
              type="button"
              className="ui-btn"
              disabled={busy || scanning || !editor}
              onClick={() => void send(false)}
              data-testid="composer-send-only"
            >
              {t("compose.sendOnly")}
            </button>
          ) : null}
          {editing ? null : (
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={busy || scanning || !editor}
              aria-busy={busy || undefined}
              onClick={() => void send(kind === "reply" && canSetPending)}
              data-testid="composer-send"
            >
              <Send aria-hidden="true" />
              {busy
                ? t("compose.sending")
                : kind === "note"
                  ? t("compose.addNote")
                  : canSetPending
                    ? t("compose.sendPending")
                    : t("compose.sendReply")}
            </button>
          )}
        </div>
      </div>
      {later ? (
        <WhenDialog
          title={editing ? t("compose.changeTitle") : t("compose.laterTitle")}
          submitLabel={editing ? t("compose.saveChangeSubmit") : t("compose.laterSubmit")}
          busyLabel={t("compose.scheduling")}
          initial={editing?.sendAt}
          onSubmit={schedule}
          onClose={() => setLater(false)}
          testId="composer-when"
        >
          {canSetPending ? (
            <fieldset className="ui-check-list">
              <legend className="ui-label">{t("compose.laterAction")}</legend>
              {[true, false].map((pending) => (
                <label key={String(pending)} className="ui-check-label">
                  <input
                    type="radio"
                    className="ui-check"
                    name={`${formId}-later-action`}
                    checked={laterPending === pending}
                    onChange={() => setLaterPending(pending)}
                    data-pending={pending}
                  />
                  {pending ? t("compose.sendPending") : t("compose.sendOnly")}
                </label>
              ))}
              <p className="ui-hint">{t("compose.laterActionHint")}</p>
            </fieldset>
          ) : null}
        </WhenDialog>
      ) : null}
    </section>
  )
}

function ReplyFields(props: {
  compose: ComposeView
  formId: string
  from: string
  to: string
  cc: string
  busy: boolean
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onCc: (value: string) => void
}) {
  const { t } = useI18n()
  const { compose, formId } = props
  return (
    <div className="ui-composer-fields">
      <label className="ui-label" htmlFor={`${formId}-from`}>
        {t("compose.from")}
      </label>
      <div className="ui-composer-from">
        <bdi dir="auto" className="ui-composer-sender">
          {compose.senderName}
        </bdi>
        {compose.from.length > 0 ? (
          <select
            id={`${formId}-from`}
            className="ui-input ui-select ui-mono"
            dir="ltr"
            value={props.from}
            disabled={props.busy}
            onChange={(event) => props.onFrom(event.target.value)}
          >
            {compose.from.map((address) => (
              <option key={address} value={address}>
                {address}
              </option>
            ))}
          </select>
        ) : (
          <span className="ui-muted">{t("compose.noFrom")}</span>
        )}
      </div>
      <label className="ui-label" htmlFor={`${formId}-to`}>
        {t("compose.to")}
      </label>
      <input
        id={`${formId}-to`}
        className="ui-input ui-mono"
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        value={props.to}
        disabled={props.busy}
        onChange={(event) => props.onTo(event.target.value)}
      />
      <label className="ui-label" htmlFor={`${formId}-cc`}>
        {t("compose.cc")}
      </label>
      <input
        id={`${formId}-cc`}
        className="ui-input ui-mono"
        dir="ltr"
        spellCheck={false}
        autoComplete="off"
        value={props.cc}
        disabled={props.busy}
        onChange={(event) => props.onCc(event.target.value)}
      />
    </div>
  )
}

function PickedFile({ file, onRemove }: { file: Picked; onRemove: () => void }) {
  const { t } = useI18n()
  let state: React.ReactNode
  if (file.source === "part") state = <Tag tone="neutral">{t("compose.fromTicket")}</Tag>
  else if (file.failed) state = <span className="ui-file-hint">{file.failed}</span>
  else if (!file.upload) state = <Tag tone="info">{t("compose.uploading")}</Tag>
  else state = <Tag tone={UPLOAD_TONE[file.upload.status]}>{t(`compose.upload.${file.upload.status}`)}</Tag>
  const refused = file.source === "upload" && file.upload !== null && !ATTACHABLE.has(file.upload.status)
  return (
    <li className="ui-file" data-file={file.name} data-state={file.source === "upload" ? file.upload?.status : "part"}>
      <Paperclip className="ui-file-icon" aria-hidden="true" />
      <div className="ui-file-main">
        <span className="ui-file-name">
          <bdi dir="auto">{file.name}</bdi>
        </span>
        <span className="ui-file-meta">
          {state}
          <span>{formatBytes(file.size)}</span>
        </span>
        {refused && file.source === "upload" && file.upload && file.upload.status !== "scanning" ? (
          <span className="ui-file-hint">{t(`compose.uploadHint.${file.upload.status}`)}</span>
        ) : null}
      </div>
      <div className="ui-file-acts">
        <button
          type="button"
          className="ui-icon-btn"
          aria-label={t("compose.remove", { name: file.name })}
          title={t("compose.remove", { name: file.name })}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </li>
  )
}
