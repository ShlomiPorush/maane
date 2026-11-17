// One ticket, /tickets/:number (plan 2.4): its facts, then its messages in order, each with its sender, recipients,
// date (Maane's time zone), and its body framed from GET /api/v1/messages/:id/body. The frame is sandboxed twice: by
// its own `sandbox` attribute and by the route's policy (sandbox, default-src 'none', images only as data: URLs until
// "Show remote images"). What a scan blocked shows as blocked with its signature, never its content. Files show
// their scan status in words; a clean image, PDF, or text file previews in the shared dialog, and every stored file
// downloads. A ticket outside the user's organizations reads as not found, as the server answers. Replies and internal
// notes (plan 3.1) show their author, a reply where its sending is per recipient and which of its links were clicked
// and history files downloaded (plan 3.4), and the composer comes last. The details hold the workflow (plan 4.1): the
// status, the categories, moving the ticket to another organization, and (plan 4.2) its snooze (tickets/Workflow.tsx);
// its scheduled replies show above the composer (tickets/Scheduled.tsx), and a reply one of them made is marked. The
// reminder of its waiting period that has not gone yet shows there too, with when it goes (plan 4.3,
// tickets/Reminder.tsx); a sent one is a message marked as an automatic reminder, under the organization's name.

import type { AttachmentView, ImportedTicketView, MessageView, ScheduledReplyView, TicketView } from "@maane/shared"
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
import { Banner, ErrorState, Loading, Locked, StaleNote } from "../ui/states.tsx"
import { Time } from "../ui/Time.tsx"
import { Tag } from "../ui/tags.tsx"
import { Clicks } from "./tickets/Clicks.tsx"
import { Composer } from "./tickets/Composer.tsx"
import { Delivery } from "./tickets/Delivery.tsx"
import { FilePreview } from "./tickets/FilePreview.tsx"
import { AddressLine, ScanTag, Sender, TicketNumber, TicketTags } from "./tickets/parts.tsx"
import { PendingReminder } from "./tickets/Reminder.tsx"
import { ScheduledReplies } from "./tickets/Scheduled.tsx"
import { CategoriesControl, OrganizationControl, SnoozeControl, StatusControl } from "./tickets/Workflow.tsx"

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
              <TicketTags
                status={view.ticket.status}
                flags={view.ticket.reviewFlags}
                snoozedUntil={view.ticket.snoozedUntil}
              />
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
      {/* One per ticket: its state (the scheduled reply being changed, the preview) never carries to another ticket. */}
      {view ? <Ticket key={view.ticket.number} view={view} /> : null}
    </div>
  )
}

function Ticket({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const [preview, setPreview] = useState<AttachmentView | null>(null)
  // The scheduled reply being changed, as it was when the agent chose it: a newer view never moves or drops the change
  // (one that went out or was cancelled meanwhile gets the server's refusal when saved).
  const [editing, setEditing] = useState<ScheduledReplyView | null>(null)
  const { ticket } = view
  // An imported ticket is read-only until the import is finished (plan 5.1): its values show, nothing changes them.
  const readOnly = ticket.imported?.readOnly === true
  return (
    <>
      {readOnly ? (
        <Banner tone="info" title={t("ticket.imported.readOnly")}>
          {t("ticket.imported.readOnlyHint")}
        </Banner>
      ) : null}
      <section className="ui-panel" aria-labelledby="ticket-details">
        <div className="ui-panel-head">
          <h2 id="ticket-details">{t("ticket.details")}</h2>
        </div>
        <dl className="ui-facts">
          <div>
            <dt>{t("ticket.statusLabel")}</dt>
            <dd>
              {readOnly ? (
                <Tag tone="neutral">{t(`ticket.status.${ticket.status}`)}</Tag>
              ) : (
                <StatusControl view={view} />
              )}
            </dd>
          </div>
          <div>
            <dt>{t("ticket.snooze.label")}</dt>
            <dd>
              {readOnly ? <span className="ui-muted">{t("ticket.imported.none")}</span> : <SnoozeControl view={view} />}
            </dd>
          </div>
          <div>
            <dt>{t("ticket.categories.label")}</dt>
            <dd>{readOnly ? <CategoryList view={view} /> : <CategoriesControl view={view} />}</dd>
          </div>
          <div>
            <dt>{t("ticket.organization")}</dt>
            <dd>{readOnly ? <bdi dir="auto">{ticket.organization.name}</bdi> : <OrganizationControl view={view} />}</dd>
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
                    <span className="ui-muted">{t(`ticket.link.${link.reason}`)}</span>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
      {ticket.imported ? <FromZendesk imported={ticket.imported} /> : null}
      <h2 className="ui-section-title">{t("ticket.messagesTitle")}</h2>
      {view.messages.map((message) => (
        <MessageCard
          key={message.id}
          message={message}
          ticketNumber={ticket.number}
          organizationName={ticket.organization.name}
          onPreview={setPreview}
        />
      ))}
      {readOnly ? (
        <Locked title={t("ticket.imported.composerLocked")}>{t("ticket.imported.readOnlyHint")}</Locked>
      ) : (
        <>
          <ScheduledReplies view={view} editing={editing?.id ?? null} onEdit={setEditing} />
          {view.reminder ? <PendingReminder reminder={view.reminder} /> : null}
          {/* One composer per ticket: moving to another ticket starts a fresh one (recipients, text, files, submission). */}
          <Composer
            key={ticket.number}
            view={view}
            editing={editing}
            onEditDone={() => setEditing(null)}
            onEditKeep={setEditing}
          />
        </>
      )}
      {preview ? <FilePreview file={preview} onClose={() => setPreview(null)} /> : null}
    </>
  )
}

/** The ticket's categories, shown without the control that changes them. */
function CategoryList({ view }: { view: TicketView }) {
  const { t } = useI18n()
  const own = view.ticket.categories
  if (own.length === 0) return <span className="ui-muted">{t("ticket.categories.none")}</span>
  return (
    <span className="ui-facts-list" data-testid="ticket-categories">
      {own.map((category) => (
        <bdi key={category.id} dir="auto">
          <Tag tone="neutral">{category.name}</Tag>
        </bdi>
      ))}
    </span>
  )
}

/** What the import kept of the Zendesk ticket (plan 5.1): its number, brand, tags, fields, and followers, read-only. */
function FromZendesk({ imported }: { imported: ImportedTicketView }) {
  const { t } = useI18n()
  return (
    <section className="ui-panel" aria-labelledby="ticket-zendesk" data-testid="ticket-zendesk">
      <div className="ui-panel-head">
        <h2 id="ticket-zendesk">{t("ticket.imported.title")}</h2>
      </div>
      <dl className="ui-facts">
        <div>
          <dt>{t("ticket.imported.number")}</dt>
          <dd>
            <bdi dir="ltr">{t("ticket.imported.zendeskNumber", { number: imported.zendeskId })}</bdi>
          </dd>
        </div>
        {imported.brand ? (
          <div>
            <dt>{t("ticket.imported.brand")}</dt>
            <dd>
              <bdi dir="auto">{imported.brand}</bdi>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{t("ticket.imported.tags")}</dt>
          <dd className="ui-facts-list">
            {imported.tags.length > 0 ? (
              imported.tags.map((tag) => (
                <bdi key={tag} className="ui-mono" dir="auto">
                  <Tag tone="neutral">{tag}</Tag>
                </bdi>
              ))
            ) : (
              <span className="ui-muted">{t("ticket.imported.none")}</span>
            )}
          </dd>
        </div>
        {imported.fields.map((field) => (
          <div key={field.name}>
            <dt>
              <bdi dir="auto">{field.name}</bdi>
            </dt>
            <dd>
              <bdi dir="auto">{field.value}</bdi>
            </dd>
          </div>
        ))}
        {imported.followers.length > 0 ? (
          <div>
            <dt>{t("ticket.imported.followers")}</dt>
            <dd className="ui-facts-list">
              {imported.followers.map((follower) => (
                <bdi key={`${follower.address}:${follower.name}`} dir="auto">
                  {follower.name ?? follower.address}
                </bdi>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="ui-hint ui-import-hint">{t("ticket.imported.followersHint")}</p>
    </section>
  )
}

function MessageCard({
  message,
  ticketNumber,
  organizationName,
  onPreview,
}: {
  message: MessageView
  ticketNumber: number
  /** An automatic reminder goes as the organization: its name stands where an agent's would (plan 4.3). */
  organizationName?: string
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
          {message.scheduled ? <Tag tone="info">{t("ticket.scheduledReply")}</Tag> : null}
          {message.reminder ? <Tag tone="info">{t("ticket.reminder")}</Tag> : null}
          {message.imported ? <Tag tone="info">{t("ticket.imported.tag")}</Tag> : null}
          {message.imported?.sideConversation ? (
            <Tag tone="neutral">{t("ticket.imported.sideConversation")}</Tag>
          ) : null}
          {message.author ? <bdi dir="auto">{message.author.name}</bdi> : null}
          {message.imported?.authorName && message.direction !== "in" ? (
            <span className="ui-muted">{t("ticket.imported.author", { name: message.imported.authorName })}</span>
          ) : null}
          {message.reminder && organizationName ? <bdi dir="auto">{organizationName}</bdi> : null}
          {/* An imported comment without a recorded address shows its Zendesk author's name, never an unknown sender. */}
          {message.direction === "note" ? null : message.from ? (
            <AddressLine value={message.from} />
          ) : message.imported ? (
            message.direction === "in" && message.imported.authorName ? (
              <bdi dir="auto">{message.imported.authorName}</bdi>
            ) : null
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
      {message.attachments.length > 0 ? (
        <Files files={message.attachments} imported={Boolean(message.imported)} onPreview={onPreview} />
      ) : null}
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

/** An imported file (plan 5.2) the scanner refused was never stored: its original is in the Zendesk archive, not the mailbox. */
const IMPORTED_HINTS = new Set(["infected", "blocked_type"])

function Files({
  files,
  imported,
  onPreview,
}: {
  files: AttachmentView[]
  imported: boolean
  onPreview: (file: AttachmentView) => void
}) {
  const { t } = useI18n()
  const hint = (status: AttachmentView["status"]) =>
    imported && IMPORTED_HINTS.has(status)
      ? t(`scan.hintImported.${status as "infected" | "blocked_type"}`)
      : t(`scan.hint.${status}`)
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
              {file.status === "clean" ? null : <span className="ui-file-hint">{hint(file.status)}</span>}
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
