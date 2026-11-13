// One ticket, /tickets/:number (plan 2.4): its facts, then its messages in order, each with its sender, recipients,
// date (Maane's time zone), and its body framed from GET /api/v1/messages/:id/body. The frame is sandboxed twice: by
// its own `sandbox` attribute and by the route's policy (sandbox, default-src 'none', images only as data: URLs until
// "Show remote images"). What a scan blocked shows as blocked with its signature, never its content. Files show
// their scan status in words; a clean image, PDF, or text file previews in the shared dialog, and every stored file
// downloads. A ticket outside the user's organizations reads as not found, as the server answers. Replies and internal
// notes (plan 3.1) show their author, a reply where its sending is per recipient and which of its links were clicked
// and history files downloaded (plan 3.4), and the composer comes last.

import type { AttachmentView, MessageView, TicketView } from "@maane/shared"
import { Download, Eye, Paperclip } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router"
import { ApiError } from "../api/client.ts"
import { api, bodyUrl, downloadUrl, qk } from "../api/endpoints.ts"
import { formatBytes } from "../format/number.ts"
import { useI18n } from "../i18n/i18n.tsx"
import { PageHead } from "../shell/chrome.tsx"
import { usePageMeta } from "../shell/pageMeta.tsx"
import { Copyable } from "../ui/Copyable.tsx"
import { EVERY, usePageQuery } from "../ui/refresh.ts"
import { Banner, ErrorState, Loading, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Tag } from "../ui/tags.tsx"
import { Clicks } from "./tickets/Clicks.tsx"
import { Composer } from "./tickets/Composer.tsx"
import { Delivery } from "./tickets/Delivery.tsx"
import { FilePreview } from "./tickets/FilePreview.tsx"
import { AddressLine, ScanTag, Sender, TicketNumber, TicketTags } from "./tickets/parts.tsx"

const NUMBER = /^[1-9][0-9]{0,15}$/

export function TicketPage() {
  const { t } = useI18n()
  const raw = useParams().number ?? ""
  const number = NUMBER.test(raw) ? Number(raw) : 0
  const query = usePageQuery({
    queryKey: qk.ticket(number),
    queryFn: () => api.ticket(number),
    every: EVERY.live,
    enabled: number > 0,
  })
  const view = query.data
  const missing = number === 0 || (query.error instanceof ApiError && query.error.status === 404)
  const title = view ? (view.ticket.subject ?? t("tickets.noSubject")) : missing ? t("ticket.notFound") : `#${raw}`
  usePageMeta(title, [{ label: t("tickets.title"), to: "/" }])

  if (missing)
    return (
      <div className="ui-page">
        <div className="ui-panel">
          <div className="ui-empty" data-testid="ticket-missing">
            <b>{t("ticket.notFound")}</b>
            <span>{t("ticket.notFoundHint")}</span>
            <Link to="/" className="ui-btn">
              {t("ticket.back")}
            </Link>
          </div>
        </div>
      </div>
    )

  return (
    <div className="ui-page">
      <PageHead
        title={title}
        titleDir="auto"
        description={
          view ? (
            <p className="ui-page-desc ui-ticket-desc">
              <TicketNumber number={view.ticket.number} />
              <span aria-hidden="true">·</span>
              <bdi dir="auto">{view.ticket.organization.name}</bdi>
              <TicketTags status={view.ticket.status} flags={view.ticket.reviewFlags} />
            </p>
          ) : null
        }
      />
      {query.isPending ? (
        <div className="ui-panel">
          <Loading label={t("ticket.loading")} />
        </div>
      ) : null}
      {query.isError && !view ? (
        <div className="ui-panel">
          <ErrorState title={t("ticket.failed")} error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : null}
      <StaleNote failed={query.isError && Boolean(view)} />
      {view ? <Ticket view={view} /> : null}
    </div>
  )
}

function Ticket({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<AttachmentView | null>(null)
  const { ticket } = view
  return (
    <>
      <section className="ui-panel" aria-labelledby="ticket-details">
        <div className="ui-panel-head">
          <h2 id="ticket-details">{t("ticket.details")}</h2>
        </div>
        <dl className="ui-facts">
          <div>
            <dt>{t("ticket.organization")}</dt>
            <dd>
              <bdi dir="auto">{ticket.organization.name}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("ticket.supportAddress")}</dt>
            <dd>
              <Copyable value={ticket.supportAddress} dir="ltr" />
            </dd>
          </div>
          <div>
            <dt>{t("ticket.reference")}</dt>
            <dd>
              <Copyable value={ticket.referenceCode} dir="ltr" />
            </dd>
          </div>
          <div>
            <dt>{t("ticket.opened")}</dt>
            <dd>
              <Time value={ticket.createdAt} mode="full" />
            </dd>
          </div>
          <div>
            <dt>{t("ticket.lastActivity")}</dt>
            <dd>
              <Time value={ticket.lastActivityAt} mode="full" />
            </dd>
          </div>
          <div>
            <dt>{t("ticket.participants")}</dt>
            <dd className="ui-facts-list">
              {view.participants.map((participant) => (
                <AddressLine key={participant.address} value={participant} />
              ))}
            </dd>
          </div>
          {view.links.length > 0 ? (
            <div>
              <dt>{t("ticket.linked")}</dt>
              <dd className="ui-facts-list">
                {view.links.map((link) => (
                  <span key={link.number}>
                    <Link to={`/tickets/${link.number}`}>
                      <TicketNumber number={link.number} />
                    </Link>{" "}
                    <span className="ui-muted">{t(`flag.${link.reason}`)}</span>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      <h2 className="ui-section-title">{t("ticket.messagesTitle")}</h2>
      {view.messages.map((message) => (
        <MessageCard key={message.id} message={message} ticketNumber={ticket.number} onPreview={setPreview} />
      ))}
      {/* One composer per ticket: moving to another ticket starts a fresh one (recipients, text, files, submission). */}
      <Composer key={ticket.number} view={view} />
      {preview ? <FilePreview file={preview} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

function MessageCard({
  message,
  ticketNumber,
  onPreview,
}: {
  message: MessageView
  ticketNumber: number
  onPreview: (file: AttachmentView) => void
}) {
  const { t } = useI18n()
  return (
    <article
      className="ui-panel ui-message"
      data-message={message.id}
      data-direction={message.direction}
      aria-label={message.subject ?? undefined}
    >
      <header className="ui-message-head">
        <span className="ui-message-from">
          {message.direction !== "in" ? <Tag tone="neutral">{t(`ticket.direction.${message.direction}`)}</Tag> : null}
          {message.author ? <bdi dir="auto">{message.author.name}</bdi> : null}
          {message.direction === "note" ? null : message.from ? (
            <AddressLine value={message.from} />
          ) : (
            <Sender sender={null} />
          )}
          {message.reviewFlags.map((flag) => (
            <Tag key={flag} tone="warn">
              {t(`flag.${flag}`)}
            </Tag>
          ))}
        </span>
        <Time value={message.sentAt ?? message.receivedAt} mode="full" />
      </header>
      {message.delivery ? null : (
        <dl className="ui-message-to">
          {message.to.length > 0 ? (
            <div>
              <dt>{t("ticket.to")}</dt>
              <dd>
                {message.to.map((address) => (
                  <AddressLine key={address.address} value={address} />
                ))}
              </dd>
            </div>
          ) : null}
          {message.cc.length > 0 ? (
            <div>
              <dt>{t("ticket.cc")}</dt>
              <dd>
                {message.cc.map((address) => (
                  <AddressLine key={address.address} value={address} />
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      )}
      {message.content !== "parsed" ? <Banner tone="warn" title={t(`ticket.content.${message.content}`)} /> : null}
      {message.fields.map((notice) => (
        <div className="ui-message-notice" key={notice.field} data-field={notice.field}>
          <Banner
            tone={notice.status === "infected" || notice.status === "blocked_type" ? "fail" : "warn"}
            title={t("ticket.fieldNotice", {
              field: t(`ticket.field.${notice.field}`),
              status: t(`scan.status.${notice.status}`),
            })}
          >
            {notice.signature ? (
              <>
                {t("ticket.signature")}:{" "}
                <bdi className="ui-mono" dir="ltr">
                  {notice.signature}
                </bdi>
                {". "}
              </>
            ) : null}
            {notice.status === "clean" ? null : t(`scan.hint.${notice.status}`)}
          </Banner>
        </div>
      ))}
      {message.body ? (
        <MailFrame message={message} />
      ) : message.content === "parsed" && message.fields.length === 0 ? (
        <p className="ui-message-empty">{t("ticket.noBody")}</p>
      ) : null}
      {message.attachments.length > 0 ? <Files files={message.attachments} onPreview={onPreview} /> : null}
      {message.delivery ? (
        <Delivery messageId={message.id} ticketNumber={ticketNumber} delivery={message.delivery} />
      ) : null}
      {message.links?.length ? <Clicks links={message.links} /> : null}
    </article>
  )
}

/** The frame's height, from how many lines the message's text has: a frame cannot be measured from outside. */
function frameHeight(lines: number): number {
  return Math.min(640, Math.max(140, 44 + lines * 22))
}

/** The body in its sandboxed frame, with "Show remote images" for a message that has any (per message, not kept). */
function MailFrame({ message }: { message: MessageView }) {
  const { t, tc } = useI18n()
  const [images, setImages] = useState(false)
  const sender = message.from?.name ?? message.from?.address ?? t("tickets.unknownSender")
  return (
    <div className="ui-mail">
      {message.remoteImages > 0 ? (
        <div className="ui-mail-images" data-images={images ? "shown" : "hidden"}>
          <span>{images ? t("ticket.imagesShown") : tc("ticket.imagesHidden", message.remoteImages)}</span>
          <button type="button" className="ui-btn ui-btn-sm" onClick={() => setImages(!images)}>
            {images ? t("ticket.hideImages") : t("ticket.showImages")}
          </button>
        </div>
      ) : null}
      <iframe
        className="ui-mail-frame"
        title={t("ticket.frameTitle", { sender })}
        src={bodyUrl(message.id, message.bodyVersion, images)}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{ height: `${frameHeight(message.bodyLines)}px` }}
      />
    </div>
  )
}

function Files({ files, onPreview }: { files: AttachmentView[]; onPreview: (file: AttachmentView) => void }) {
  const { t } = useI18n()
  return (
    <section className="ui-files" aria-label={t("ticket.files")}>
      <h3 className="ui-files-title">{t("ticket.files")}</h3>
      <ul>
        {files.map((file) => (
          <li key={file.id} className="ui-file" data-file={file.fileName ?? ""} data-status={file.status}>
            <Paperclip className="ui-file-icon" aria-hidden="true" />
            <div className="ui-file-main">
              <span className="ui-file-name">
                <bdi dir="auto">{file.fileName ?? t("ticket.noFileName")}</bdi>
              </span>
              <span className="ui-file-meta">
                <ScanTag status={file.status} />
                <span>{formatBytes(file.size)}</span>
                {file.kind === "inline" ? <span>{t("ticket.inline")}</span> : null}
                {file.signature ? (
                  <span>
                    {t("ticket.signature")}:{" "}
                    <bdi className="ui-mono" dir="ltr">
                      {file.signature}
                    </bdi>
                  </span>
                ) : null}
                {file.blockedBy ? (
                  <span>
                    {t("ticket.blockedBy")}:{" "}
                    <bdi className="ui-mono" dir="ltr">
                      {file.blockedBy}
                    </bdi>
                  </span>
                ) : null}
              </span>
              {file.status === "clean" ? null : <span className="ui-file-hint">{t(`scan.hint.${file.status}`)}</span>}
            </div>
            <div className="ui-file-acts">
              {file.preview ? (
                <button type="button" className="ui-btn ui-btn-sm" onClick={() => onPreview(file)}>
                  <Eye aria-hidden="true" />
                  {t("ticket.preview")}
                </button>
              ) : null}
              {file.download ? (
                <a className="ui-btn ui-btn-sm" href={downloadUrl(file.id)} download>
                  <Download aria-hidden="true" />
                  {t("ticket.download")}
                </a>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
