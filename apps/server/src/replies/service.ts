// Replies and internal notes (plan 3.1): what the composer starts from, writing a reply or a note, the uploads it
// attaches, and the agent's decision about a reply whose fate is unknown. The server never sends: it builds the
// message once, writes it with its outbox row, its recipients, and the queue job that sends it in one transaction, and
// the worker sends it. Every query takes the user's scope (visibleOrganizations, read on each request).
//
// One reply per click: the composer sends a submission ID, and a unique index on (author, submission ID) makes a
// repeated or lost request find the same message. Only the ticket's own files and the user's own uploads can be
// attached, and the server reads their bytes itself. The From address must belong to the ticket's organization (the
// worker checks it again when it sends).
//
// A scheduled reply (plan 4.2) is built here too, at once, dated at its time, and stored as its timed action's version
// (`scheduled_reply`): the worker writes it at its time through write.ts, as submit writes a reply sent now. Its author
// changes it (a new version, built again) and anyone who sees the ticket cancels it, until it starts sending.

import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  type ActionReason,
  type ActionState,
  ADDRESS_MAX,
  ATTACHABLE_UPLOAD_STATUSES,
  ATTACHMENTS_MAX,
  type ComposeView,
  type MailAddress,
  MESSAGE_MAX_BYTES,
  MESSAGES,
  mayChangeStatus,
  type OutboxState,
  outboxStateOf,
  parseExactAddress,
  RECIPIENTS_MAX,
  REPLY_HTML_MAX,
  type ScheduledReplyView,
  STORED_STATUSES,
  type TicketStatus,
  type UploadView,
} from "@maane/shared"
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { actionPassed, lockAction, OPEN_ACTION_STATES, setActionState } from "../actions/timed.ts"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import {
  authUser,
  message,
  messagePart,
  organization,
  outbox,
  outboxRecipient,
  scheduledReply,
  storedFile,
  ticket,
  ticketParticipant,
  timedAction,
  upload,
} from "../db/schema.ts"
import { refreshDeliveryFlag } from "../delivery/service.ts"
import { storedFilePath } from "../files/paths.ts"
import { refuseImported } from "../imports/window.ts"
import { type JobQueue, SEND_REPLY, TIMED_ACTION, transactionWithJobs, UPLOAD_SCAN } from "../jobs/queue.ts"
import { linkBase, ReplyLinks } from "../links/service.ts"
import { contentIdsIn, sanitizeMailHtml } from "../mail/html.ts"
import { Refusal } from "../organizations/refusal.ts"
import { inScope, type OrganizationScope } from "../organizations/scope.ts"
import { reminderMayGoAgain } from "../reminders/checks.ts"
import { endWaitingPeriod, startWaitingPeriod } from "../reminders/periods.ts"
import type { Settings } from "../settings/service.ts"
import { wellFormedText } from "../text.ts"
import { changeStatus, lockTicket } from "../tickets/status.ts"
import { EMBEDDABLE_TYPES, imagesToRead, prepareImage } from "./images.ts"
import type { Entry, EntryImage } from "./layout.ts"
import {
  buildReply,
  GMAIL_HTML_BUDGET,
  htmlToText,
  MessageTooLarge,
  newMessageId,
  type ReplyAttachment,
  ReplyTooLong,
  replySubject,
  storedBody,
} from "./mail.ts"
import { belongsTo, fromAddresses, supportRules } from "./rules.ts"
import { type BuiltReply, type ReadyMessage, type ReplyFile, writeMessage } from "./write.ts"

/** The user a request acts for. */
export type ReplyUser = { id: string; role: string; actor: Actor; ipAddress: string | null }

const Address = z.object({ address: z.string().max(ADDRESS_MAX), name: z.string().max(200).nullable() })

/** What the composer submits. */
export const ReplyBody = z.object({
  submissionId: z.uuid(),
  kind: z.enum(["reply", "note"]),
  from: z.string().max(ADDRESS_MAX).nullable(),
  to: z.array(Address).max(RECIPIENTS_MAX),
  cc: z.array(Address).max(RECIPIENTS_MAX),
  html: z.string().max(REPLY_HTML_MAX),
  uploads: z.array(z.uuid()).max(ATTACHMENTS_MAX),
  parts: z.array(z.uuid()).max(ATTACHMENTS_MAX),
  /** A reply only: set the ticket to pending in the reply's transaction (plan 4.1); absent leaves the status. */
  setPending: z.boolean().optional(),
  /** A reply only: send it at this instant instead of now (plan 4.2). */
  sendAt: z.iso.datetime({ offset: true }).optional(),
})
export type ReplyBodyInput = z.infer<typeof ReplyBody>

/** A change of a scheduled reply (plan 4.2): everything again, its time, and the version it changes. */
export const ScheduledBody = ReplyBody.omit({ submissionId: true, kind: true, sendAt: true }).extend({
  sendAt: z.iso.datetime({ offset: true }),
  version: z.number().int().positive(),
})
export type ScheduledBodyInput = z.infer<typeof ScheduledBody>

/** A ticket the user may see, with its organization's name and signature. */
type FoundTicket = { ticket: typeof ticket.$inferSelect; organizationName: string; signature: string }

/** A file a reply attaches, with where the agent picked it (a scheduled reply keeps that, so it can be changed). */
type PickedFile = ReplyFile & { source: "upload" | "part"; id: string }

/** The longest file name an upload keeps, in characters. */
export const UPLOAD_NAME_MAX = 200

/** A display name for a header or a list: one line, well formed, trimmed, bounded. */
function cleanName(name: string | null): string | null {
  if (name === null) return null
  const value = [...wellFormedText(name.replace(/[\r\n\t]+/g, " ")).value.trim()].slice(0, 200).join("")
  return value === "" ? null : value
}

/** A file name to store and send: well formed, without control characters or separators, bounded. */
export function cleanFileName(name: string): string {
  const kept = [...wellFormedText(name).value]
    .map((char) => {
      const point = char.codePointAt(0) ?? 0
      return point < 0x20 || (point >= 0x7f && point <= 0x9f) || char === "/" || char === "\\" ? "_" : char
    })
    .join("")
    .trim()
  const bounded = [...kept].slice(0, UPLOAD_NAME_MAX).join("")
  return bounded === "" || bounded === "." || bounded === ".." ? "file" : bounded
}

/** Recipients parsed, in lower case, each once (an address in To is not repeated in Cc). */
function recipients(to: MailAddress[], cc: MailAddress[]): { to: MailAddress[]; cc: MailAddress[] } {
  const seen = new Set<string>()
  const parse = (list: MailAddress[]) =>
    list.flatMap((entry) => {
      const parsed = parseExactAddress(entry.address)
      if (!parsed.ok) throw new Refusal("recipient_invalid", 400, { address: entry.address })
      if (seen.has(parsed.value)) return []
      seen.add(parsed.value)
      return [{ address: parsed.value, name: cleanName(entry.name) }]
    })
  const parsedTo = parse(to)
  const parsedCc = parse(cc)
  if (parsedTo.length + parsedCc.length > RECIPIENTS_MAX) throw new Refusal("recipients_too_many", 400)
  return { to: parsedTo, cc: parsedCc }
}

/** The bytes files take in a message as base64 (four characters for every three bytes), without line breaks. */
export const encodedSize = (files: readonly { size: number }[]) =>
  files.reduce((sum, file) => sum + Math.ceil(file.size / 3) * 4, 0)

/** The statuses of a stored part (STORED_STATUSES): a file the history names. */
const STORED = new Set<string>(STORED_STATUSES)

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

export class Replies {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly jobs: JobQueue,
    private readonly filesDir: string,
    /** The public URL: tracked links and download links use its origin when no link domain is set. */
    private readonly publicUrl: URL,
  ) {}

  /** The agent's display name: the name an admin set, else the username. */
  async #agentName(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: authUser.name, username: authUser.username })
      .from(authUser)
      .where(eq(authUser.id, userId))
    return row?.name || row?.username || userId
  }

  /** The ticket by number in the scope, with its organization's name and signature; null outside it. */
  async #ticket(scope: OrganizationScope, number: number): Promise<FoundTicket | null> {
    const [row] = await this.db
      .select({ ticket, organizationName: organization.name, signature: organization.signature })
      .from(ticket)
      .innerJoin(organization, eq(organization.id, ticket.organizationId))
      .where(eq(ticket.number, number))
    if (!row || !inScope(scope, row.ticket.organizationId)) return null
    return row
  }

  /** What the composer of a ticket starts from (the ticket view carries it). */
  async compose(
    userId: string,
    found: { id: string; organizationId: string; supportAddress: string },
    organizationName: string,
    signature: string,
  ): Promise<ComposeView> {
    const { from, defaultFrom } = fromAddresses(await supportRules(this.db), found.organizationId, found.supportAddress)
    const participants = await this.db
      .select({ address: ticketParticipant.address, name: ticketParticipant.name })
      .from(ticketParticipant)
      .where(eq(ticketParticipant.ticketId, found.id))
      .orderBy(asc(ticketParticipant.createdAt), asc(ticketParticipant.address))
    const [first, ...others] = participants
    return {
      from,
      defaultFrom,
      to: first ? [first] : [],
      cc: others,
      signature,
      senderName: `${await this.#agentName(userId)} (${organizationName})`,
    }
  }

  /**
   * Writes a reply (with its outbox row, recipients, and send job) or an internal note, once per submission ID.
   * Returns the message's ID; the same ID again for a repeated submission. A reply with `sendAt` is scheduled instead
   * (plan 4.2), and the answer names the scheduled reply.
   */
  async submit(
    scope: OrganizationScope,
    user: ReplyUser,
    number: number,
    input: ReplyBodyInput,
  ): Promise<{ id: string } | { scheduled: string }> {
    if (input.sendAt !== undefined) return this.#schedule(scope, user, number, input, new Date(input.sendAt))
    const existing = await this.#submitted(user.id, input.submissionId)
    if (existing) return existing
    // One submission is one click: an ID a scheduled reply took is refused here, never written as a second message.
    if (await this.#scheduledBy(user.id, input.submissionId)) throw new Refusal("submission_reused", 409)
    const found = await this.#ticket(scope, number)
    if (!found) throw new Refusal("not_found", 404)
    const t = found.ticket
    // An imported ticket is read-only until the import is finished (plan 5.1): before the send point's checks, so a
    // note and a reply give the same answer; again under the ticket's lock below.
    await refuseImported(this.db, t.id)
    const isReply = input.kind === "reply"
    const now = new Date()
    const ready = await this.#prepare(found, user, input, now)

    const written = await transactionWithJobs(this.db, async (tx, jobs) => {
      // The ticket locked first: its status is decided from this row, a move since it was read out of the author's scope
      // leaves nothing to write to (a note too), and any move since then refuses a reply's From.
      const locked = await lockTicket(tx, t.id)
      if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
      await refuseImported(tx, locked.id)
      if (isReply && locked.organizationId !== t.organizationId) throw new Refusal("from_not_allowed", 400)
      // Again under the ticket lock: a scheduled reply with this ID that committed while this request waited for it.
      if (await this.#scheduledBy(user.id, input.submissionId, tx)) throw new Refusal("submission_reused", 409)
      const id = await writeMessage(
        tx,
        { ticketId: t.id, authorUserId: user.id, submissionId: input.submissionId, at: now, ready },
        (data) => this.jobs.sendIn(jobs, SEND_REPLY, data),
      )
      // The same submission committed meanwhile: nothing more is written, and its message is returned below.
      if (!id) return null
      // "Send and set pending" (plan 4.1): in the reply's own transaction, by the one status rule, never on acceptance.
      // A plain send and an internal note leave the status as it is. Plan 4.3: a reply ends the ticket's waiting period,
      // and one that leaves the ticket pending starts a new one, with its reminder, now that it goes to sending.
      if (isReply) {
        await endWaitingPeriod(tx, t.id, "agent_reply")
        if (input.setPending) {
          await changeStatus(tx, locked, "pending", user, "reply")
          if (locked.status === "pending")
            await startWaitingPeriod(tx, t.id, id, (data, startAfter) =>
              this.jobs.sendIn(jobs, TIMED_ACTION, data, { startAfter }),
            )
        }
      }
      await tx.update(ticket).set({ lastActivityAt: now }).where(eq(ticket.id, t.id))
      await writeAudit(tx, user.actor, {
        action: isReply ? "message.reply" : "message.note",
        entityType: "message",
        entityId: id,
        details: {
          ticket: t.number,
          ...(isReply
            ? { from: ready.from, recipients: [...ready.to, ...ready.cc].map((entry) => entry.address) }
            : {}),
          files: ready.files.length,
        },
        ipAddress: user.ipAddress,
      })
      return { id }
    })
    if (written) return written
    const again = await this.#submitted(user.id, input.submissionId)
    if (!again) throw new Error("a submission that conflicted was not found")
    return again
  }

  /**
   * Everything a reply or a note needs before its transaction: the checks of the send point (a reply's From address,
   * its recipients), the sanitized body with the signature, the files read and checked, and
   * for a reply the email built once (dated `date`: now, or a scheduled reply's time) with its links.
   */
  async #prepare(
    found: FoundTicket,
    user: ReplyUser,
    input: Pick<ReplyBodyInput, "kind" | "from" | "to" | "cc" | "html" | "uploads" | "parts">,
    date: Date,
  ): Promise<ReadyMessage & { files: PickedFile[]; agentHtml: string }> {
    const t = found.ticket
    const isReply = input.kind === "reply"
    let from: string | null = null
    let people: { to: MailAddress[]; cc: MailAddress[] } = { to: [], cc: [] }
    if (isReply) {
      const parsed = parseExactAddress(input.from ?? "")
      if (!parsed.ok || !belongsTo(parsed.value, await supportRules(this.db), t.organizationId))
        throw new Refusal("from_not_allowed", 400)
      from = parsed.value
      people = recipients(input.to, input.cc)
      if (people.to.length === 0) throw new Refusal("recipients_required", 400)
    }

    const html = sanitizeMailHtml(wellFormedText(input.html).value)
    const text = htmlToText(html)
    const files = await this.#attachments(user.id, t.id, input)
    if (text === "" && files.length === 0) throw new Refusal("reply_empty", 400)
    const body = storedBody(html, text, isReply ? found.signature : "")

    let built: BuiltReply | null = null
    let links: ReplyLinks | null = null
    if (isReply && from) {
      const parent = await this.#parent(t.id)
      const locale = await this.settings.get("general.defaultLocale")
      const messageId = newMessageId(from)
      const subject = replySubject(t.subject, t.number)
      const references = parent ? [...parent.references.slice(-20), parent.id] : []
      // The reply's own files alone, as base64, already over the provider's limit: refused at once, before any byte is
      // read or any message built (plan 3.2). The built message is checked again below.
      if (encodedSize(files) > MESSAGE_MAX_BYTES)
        throw new Refusal("message_too_large", 400, { max: MESSAGE_MAX_BYTES })
      const attachments: ReplyAttachment[] = []
      for (const file of files) attachments.push({ ...file, content: await this.#bytes(file.sha256) })
      const authorName = await this.#agentName(user.id)
      // What the history's images may take: the provider's limit as raw bytes (base64 adds a third), less the reply's
      // own files and a margin for the rest of the message.
      const imageBudget =
        Math.floor((MESSAGE_MAX_BYTES * 3) / 4) - files.reduce((sum, file) => sum + file.size, 0) - 1_000_000
      // Links (plan 3.4): the agent's http and https links become tracked links while tracking is on; each file the
      // history names gets a download link either way. Their rows are written with the reply.
      links = new ReplyLinks(
        linkBase(await this.settings.get("links.domain"), this.publicUrl),
        (await this.settings.get("links.tracking")) === "on",
      )
      const history = await this.#history(t.id, found.organizationName, from, Math.max(0, imageBudget), links)
      const mime = await buildReply({
        from: { address: from, name: `${authorName} (${found.organizationName})` },
        to: people.to,
        cc: people.cc,
        subject,
        messageId,
        inReplyTo: parent?.id ?? null,
        references,
        date,
        words: MESSAGES[locale].mail,
        lang: locale,
        referenceCode: t.referenceCode,
        authorName,
        // The reply as the ticket view keeps it: the agent's text and the organization's signature.
        html: body.html,
        text: body.text,
        fallbackDirection: locale === "he" ? "rtl" : "ltr",
        attachments,
        history,
        link: links.url,
      }).catch((error: unknown) => {
        // Refused before anything is written or queued (plan 3.2).
        if (error instanceof MessageTooLarge) throw new Refusal("message_too_large", 400, { max: MESSAGE_MAX_BYTES })
        if (error instanceof ReplyTooLong) throw new Refusal("reply_too_long", 400, { max: GMAIL_HTML_BUDGET })
        throw error
      })
      built = { mime, messageId, subject, inReplyTo: parent?.id ?? null, references }
    }
    return {
      kind: input.kind,
      from,
      to: people.to,
      cc: people.cc,
      html: body.html,
      text: body.text,
      files,
      built,
      links: links?.rows ?? [],
      // The agent's text alone, cleaned as the body is (no NUL, sanitized), without the signature.
      agentHtml: html,
    }
  }

  /**
   * Schedules a reply (plan 4.2): built now as it will go (dated at its time), stored as the action's first version, and
   * a `timed-action` job queued for that time in the same transaction. Once per submission ID. "Send and set pending"
   * applies when the reply goes to the send point, not now; it is refused now where this user may not set pending.
   */
  async #schedule(
    scope: OrganizationScope,
    user: ReplyUser,
    number: number,
    input: ReplyBodyInput,
    sendAt: Date,
  ): Promise<{ scheduled: string }> {
    if (input.kind !== "reply") throw new Refusal("request_invalid", 400)
    const existing = await this.#scheduledBy(user.id, input.submissionId)
    if (existing) return { scheduled: existing }
    // An ID a reply or a note sent now took is refused, as the other way round.
    if (await this.#submitted(user.id, input.submissionId)) throw new Refusal("submission_reused", 409)
    if (sendAt.getTime() <= Date.now()) throw new Refusal("time_past", 400)
    const found = await this.#ticket(scope, number)
    if (!found) throw new Refusal("not_found", 404)
    const t = found.ticket
    await refuseImported(this.db, t.id)
    if (input.setPending && !mayChangeStatus(user.role, t.status as TicketStatus, "pending"))
      throw new Refusal("status_admin_only", 403)
    const ready = await this.#prepare(found, user, input, sendAt)
    const id = await transactionWithJobs(this.db, async (tx, jobs) => {
      const locked = await lockTicket(tx, t.id)
      if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
      await refuseImported(tx, locked.id)
      if (locked.organizationId !== t.organizationId) throw new Refusal("from_not_allowed", 400)
      // Again under the ticket lock: a reply or a note with this ID that committed while this request waited for it.
      if (await this.#submitted(user.id, input.submissionId, tx)) throw new Refusal("submission_reused", 409)
      const [row] = await tx
        .insert(timedAction)
        .values({
          kind: "reply",
          ticketId: t.id,
          authorUserId: user.id,
          submissionId: input.submissionId,
          dueAt: sendAt,
        })
        .onConflictDoNothing()
        .returning({ id: timedAction.id, version: timedAction.version })
      if (!row) return null
      await tx.insert(scheduledReply).values({ actionId: row.id, ...this.#content(ready, input) })
      await this.jobs.sendIn(jobs, TIMED_ACTION, { actionId: row.id, version: row.version }, { startAfter: sendAt })
      await writeAudit(tx, user.actor, {
        action: "message.schedule",
        entityType: "timed_action",
        entityId: row.id,
        details: this.#scheduleDetails(t.number, ready, sendAt),
        ipAddress: user.ipAddress,
      })
      return row.id
    })
    if (id) return { scheduled: id }
    const again = await this.#scheduledBy(user.id, input.submissionId)
    if (!again) throw new Error("a scheduled submission that conflicted was not found")
    return { scheduled: again }
  }

  /** The columns of a scheduled reply's version, from what #prepare made. */
  #content(ready: ReadyMessage & { files: PickedFile[]; agentHtml: string }, input: { setPending?: boolean }) {
    if (!ready.built || !ready.from) throw new Error("a scheduled reply without its email")
    return {
      setPending: input.setPending === true,
      // What the composer loads again for a change: the agent's text as #prepare cleaned it, never the raw request.
      editorHtml: ready.agentHtml,
      fromAddress: ready.from,
      toAddresses: ready.to,
      ccAddresses: ready.cc,
      htmlBody: ready.html,
      textBody: ready.text,
      files: ready.files,
      mime: ready.built.mime,
      messageIdHeader: ready.built.messageId,
      subject: ready.built.subject,
      inReplyTo: ready.built.inReplyTo,
      references: ready.built.references,
      links: ready.links,
    }
  }

  #scheduleDetails(number: number, ready: ReadyMessage, sendAt: Date) {
    return {
      ticket: number,
      from: ready.from,
      recipients: [...ready.to, ...ready.cc].map((entry) => entry.address),
      files: ready.files.length,
      sendAt: sendAt.toISOString(),
    }
  }

  async #scheduledBy(userId: string, submissionId: string, db: Db = this.db): Promise<string | null> {
    const [row] = await db
      .select({ id: timedAction.id })
      .from(timedAction)
      .where(and(eq(timedAction.authorUserId, userId), eq(timedAction.submissionId, submissionId)))
    return row?.id ?? null
  }

  /** A scheduled reply in the user's scope, with its ticket by number; a 404 refusal otherwise. */
  async #action(scope: OrganizationScope, actionId: string) {
    const [row] = await this.db
      .select({ number: ticket.number, organizationId: ticket.organizationId, authorUserId: timedAction.authorUserId })
      .from(timedAction)
      .innerJoin(ticket, eq(ticket.id, timedAction.ticketId))
      .where(and(eq(timedAction.id, actionId), eq(timedAction.kind, "reply")))
    if (!row || !inScope(scope, row.organizationId)) throw new Refusal("not_found", 404)
    return row
  }

  /**
   * Changes a scheduled reply (plan 4.2): a new version with everything again (text, recipients, files, time), built
   * again, until it starts sending (`scheduled` or `handed`) and when the change names its current version. The older
   * version's job, and its reply if it was written, then find a newer version and do nothing. Only its author changes
   * it: its files are their own uploads.
   */
  async changeScheduled(
    scope: OrganizationScope,
    user: ReplyUser,
    actionId: string,
    input: ScheduledBodyInput,
  ): Promise<void> {
    const action = await this.#action(scope, actionId)
    if (action.authorUserId !== user.id) throw new Refusal("scheduled_not_author", 403)
    const sendAt = new Date(input.sendAt)
    if (sendAt.getTime() <= Date.now()) throw new Refusal("time_past", 400)
    const found = await this.#ticket(scope, action.number)
    if (!found) throw new Refusal("not_found", 404)
    const t = found.ticket
    await refuseImported(this.db, t.id)
    if (input.setPending && !mayChangeStatus(user.role, t.status as TicketStatus, "pending"))
      throw new Refusal("status_admin_only", 403)
    const ready = await this.#prepare(found, user, { ...input, kind: "reply" }, sendAt)
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const locked = await lockTicket(tx, t.id)
      if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
      if (locked.organizationId !== t.organizationId) throw new Refusal("from_not_allowed", 400)
      const held = await lockAction(tx, actionId)
      // Until it starts sending: also once its reply was written (`handed`). The send point then finds a newer version
      // and ends that reply without sending, and the new version's job writes its own (one outbox row per version).
      if (!held || !(OPEN_ACTION_STATES as readonly string[]).includes(held.state))
        throw new Refusal("scheduled_not_open", 409)
      if (held.version !== input.version) throw new Refusal("scheduled_changed", 409)
      const version = held.version + 1
      await tx
        .update(timedAction)
        .set({ version, state: "scheduled", reason: null, dueAt: sendAt, updatedAt: sql`now()` })
        .where(eq(timedAction.id, actionId))
      await tx.update(scheduledReply).set(this.#content(ready, input)).where(eq(scheduledReply.actionId, actionId))
      await this.jobs.sendIn(jobs, TIMED_ACTION, { actionId, version }, { startAfter: sendAt })
      await writeAudit(tx, user.actor, {
        action: "message.schedule_change",
        entityType: "timed_action",
        entityId: actionId,
        details: this.#scheduleDetails(t.number, ready, sendAt),
        ipAddress: user.ipAddress,
      })
    })
  }

  /**
   * Cancels a scheduled reply until it starts sending (`scheduled`, or `handed`: written, not yet at the send point);
   * anyone who may see the ticket may.
   */
  async cancelScheduled(scope: OrganizationScope, user: ReplyUser, actionId: string): Promise<void> {
    const action = await this.#action(scope, actionId)
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ id: ticket.id }).from(ticket).where(eq(ticket.number, action.number))
      const locked = row ? await lockTicket(tx, row.id) : null
      if (!locked || !inScope(scope, locked.organizationId)) throw new Refusal("not_found", 404)
      await refuseImported(tx, locked.id)
      const held = await lockAction(tx, actionId)
      // Until it starts sending: also once its reply was written and waits for the send point, which then refuses it.
      if (!held || held.ticketId !== locked.id || !(OPEN_ACTION_STATES as readonly string[]).includes(held.state))
        throw new Refusal("scheduled_not_open", 409)
      await setActionState(tx, actionId, "cancelled", "agent")
      await writeAudit(tx, user.actor, {
        action: "message.schedule_cancel",
        entityType: "timed_action",
        entityId: actionId,
        details: { ticket: locked.number },
        ipAddress: user.ipAddress,
      })
    })
  }

  /** A ticket's scheduled replies for its view, newest first, each with the reply it made at its time, if any. */
  async scheduled(userId: string, ticketId: string): Promise<ScheduledReplyView[]> {
    const rows = await this.db
      .select({ action: timedAction, content: scheduledReply, messageId: outbox.messageId, outboxState: outbox.state })
      .from(timedAction)
      .innerJoin(scheduledReply, eq(scheduledReply.actionId, timedAction.id))
      .leftJoin(outbox, and(eq(outbox.actionId, timedAction.id), eq(outbox.actionVersion, timedAction.version)))
      .where(and(eq(timedAction.ticketId, ticketId), eq(timedAction.kind, "reply")))
      .orderBy(desc(timedAction.createdAt))
    const names = new Map<string, string>()
    for (const row of rows) {
      const id = row.action.authorUserId
      if (id && !names.has(id)) names.set(id, await this.#agentName(id))
    }
    return rows.map(({ action, content, messageId, outboxState }) => ({
      id: action.id,
      version: action.version,
      state: action.state as ActionState,
      reason: (action.reason as ActionReason | null) ?? null,
      sendAt: action.dueAt.toISOString(),
      createdAt: action.createdAt.toISOString(),
      updatedAt: action.updatedAt.toISOString(),
      author: action.authorUserId
        ? { id: action.authorUserId, name: names.get(action.authorUserId) ?? action.authorUserId }
        : null,
      editable: (OPEN_ACTION_STATES as readonly string[]).includes(action.state) && action.authorUserId === userId,
      from: content.fromAddress,
      to: content.toAddresses as MailAddress[],
      cc: content.ccAddresses as MailAddress[],
      text: content.textBody,
      html: content.editorHtml,
      setPending: content.setPending,
      files: (content.files as PickedFile[]).map((file) => ({
        source: file.source,
        id: file.id,
        fileName: file.fileName,
        size: file.size,
      })),
      messageId: messageId ?? null,
      outboxState: (outboxState as OutboxState | null) ?? null,
    }))
  }

  async #submitted(userId: string, submissionId: string, db: Db = this.db): Promise<{ id: string } | null> {
    const [row] = await db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.authorUserId, userId), eq(message.submissionId, submissionId)))
    return row ?? null
  }

  /**
   * The public history a reply quotes, newest first (requirements 4.1): the ticket's incoming messages and its replies
   * that at least one recipient accepted (or that an agent made public in Zendesk, plan 5.1), never an internal note; each with its files' names and the images its HTML
   * embeds. An image is embedded only as the ticket view shows one: a part of the same message that scanned clean, its
   * stored file clean, with an image type, within the same sizes; prepared (downscaled) with sharp, with a new content
   * ID in the From address's domain. Every other image of the stored HTML is left out when the email is drawn.
   */
  async #history(
    ticketId: string,
    organizationName: string,
    from: string,
    imageBudget: number,
    links: ReplyLinks,
  ): Promise<Entry[]> {
    const accepted = this.db
      .select({ one: sql`1` })
      .from(outboxRecipient)
      .where(and(eq(outboxRecipient.messageId, message.id), eq(outboxRecipient.state, "accepted")))
    const rows = await this.db
      .select({
        id: message.id,
        direction: message.direction,
        receivedAt: message.receivedAt,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        authorUserId: message.authorUserId,
        html: message.htmlBody,
        text: message.textBody,
      })
      .from(message)
      .where(
        and(
          eq(message.ticketId, ticketId),
          eq(message.content, "parsed"),
          isNull(message.duplicateOf),
          // A comment an agent made public in Zendesk (plan 5.1) was sent by Zendesk: it has no outbox or delivery state.
          or(
            eq(message.direction, "in"),
            and(eq(message.direction, "out"), or(exists(accepted), isNotNull(message.zendeskKey))),
          ),
        ),
      )
      .orderBy(desc(message.receivedAt), desc(message.createdAt))
    if (rows.length === 0) return []
    const parts = await this.db
      .select({
        id: messagePart.id,
        messageId: messagePart.messageId,
        kind: messagePart.kind,
        fileName: messagePart.fileName,
        contentId: messagePart.contentId,
        status: messagePart.status,
        sha256: storedFile.sha256,
        size: storedFile.size,
        detectedType: storedFile.detectedType,
        storedStatus: storedFile.scanStatus,
      })
      .from(messagePart)
      .leftJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
      .where(
        inArray(
          messagePart.messageId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(messagePart.index))
    const names = new Map<string, string>()
    for (const row of rows)
      if (row.authorUserId && !names.has(row.authorUserId))
        names.set(row.authorUserId, await this.#agentName(row.authorUserId))
    const domain = from.slice(from.lastIndexOf("@") + 1)

    // The images each message's HTML refers to (by its decoded content ID) that may be embedded: a part of the same
    // message, inline, clean as a part and as a stored file, with an image type read from the content. Which of them
    // are read is decided from their stored sizes first (imagesToRead); the others show by their names, unread.
    const candidates = rows.flatMap((row, index) => {
      const referenced = row.html ? contentIdsIn(row.html) : new Set<string>()
      const seen = new Set<string>()
      return parts.flatMap((part) => {
        const id = part.contentId
        if (part.messageId !== row.id || part.kind !== "inline" || !id || !part.sha256 || seen.has(id)) return []
        if (!referenced.has(id) || part.status !== "clean" || part.storedStatus !== "clean") return []
        if (!EMBEDDABLE_TYPES.includes(part.detectedType as never)) return []
        seen.add(id)
        return [{ message: index, size: part.size ?? 0, id, sha256: part.sha256, type: part.detectedType ?? "", part }]
      })
    })
    const read = imagesToRead(candidates, imageBudget)

    const entries: Entry[] = rows.map((row) => {
      const own = parts.filter((part) => part.messageId === row.id)
      // Each with its download link (plan 3.4): history holds no internal note, so no note's file gets one.
      const files = own
        .filter((part) => part.kind === "attachment" && part.sha256 && STORED.has(part.status))
        .map((part) => ({ name: cleanFileName(part.fileName ?? "file"), href: links.file(part.id) }))
      const agent = row.authorUserId ? (names.get(row.authorUserId) ?? row.authorUserId) : null
      // A reply without an author is an automatic reminder (plan 4.3): it went as the organization.
      const customer =
        row.direction === "out" && !agent ? organizationName : row.fromName?.trim() || row.fromAddress || "?"
      return {
        name: agent ? `${agent} (${organizationName})` : customer,
        initialsOf: agent ?? customer,
        at: row.receivedAt,
        html: row.html !== null && row.html !== "" ? row.html : null,
        text: row.text !== null && row.text !== "" ? row.text : null,
        images: new Map<string, EntryImage>(),
        imageNames: new Map<string, string>(),
        files,
      }
    })
    for (const [index, candidate] of candidates.entries()) {
      const entry = entries[candidate.message]
      if (!entry) continue
      const fileName = cleanFileName(candidate.part.fileName ?? "image")
      const bytes = read[index] ? await this.#bytes(candidate.sha256).catch(() => null) : null
      const prepared = bytes ? await prepareImage(bytes, candidate.type) : null
      if (prepared) entry.images.set(candidate.id, { ...prepared, cid: `${randomUUID()}@${domain}`, fileName })
      else entry.imageNames?.set(candidate.id, fileName)
    }
    return entries
  }

  /** The message a reply answers: the ticket's latest message with a Message-ID (incoming or a reply, never a note). */
  async #parent(ticketId: string): Promise<{ id: string; references: string[] } | null> {
    const [row] = await this.db
      .select({ id: message.messageIdHeader, references: message.references })
      .from(message)
      .where(
        and(
          eq(message.ticketId, ticketId),
          isNotNull(message.messageIdHeader),
          inArray(message.direction, ["in", "out"]),
          eq(message.content, "parsed"),
        ),
      )
      .orderBy(desc(message.receivedAt), desc(message.createdAt))
      .limit(1)
    return row?.id ? { id: row.id, references: row.references } : null
  }

  /** The files to attach: the user's own scanned uploads and the ticket's own stored files, or a refusal. */
  async #attachments(
    userId: string,
    ticketId: string,
    input: Pick<ReplyBodyInput, "uploads" | "parts">,
  ): Promise<PickedFile[]> {
    const uploadIds = [...new Set(input.uploads)]
    const partIds = [...new Set(input.parts)]
    if (uploadIds.length + partIds.length > ATTACHMENTS_MAX) throw new Refusal("attachment_invalid", 400)
    const uploads = uploadIds.length
      ? await this.db
          .select({
            id: upload.id,
            fileName: upload.fileName,
            sha256: storedFile.sha256,
            size: storedFile.size,
            contentType: storedFile.detectedType,
            status: storedFile.scanStatus,
          })
          .from(upload)
          .innerJoin(storedFile, eq(storedFile.sha256, upload.storedSha256))
          .where(
            and(
              inArray(upload.id, uploadIds),
              eq(upload.userId, userId),
              inArray(upload.status, [...ATTACHABLE_UPLOAD_STATUSES]),
            ),
          )
      : []
    const parts = partIds.length
      ? await this.db
          .select({
            id: messagePart.id,
            fileName: messagePart.fileName,
            sha256: storedFile.sha256,
            size: storedFile.size,
            contentType: storedFile.detectedType,
            status: storedFile.scanStatus,
          })
          .from(messagePart)
          .innerJoin(message, eq(message.id, messagePart.messageId))
          .innerJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
          .where(
            and(
              inArray(messagePart.id, partIds),
              eq(message.ticketId, ticketId),
              // An internal note's files never reach a customer (review R1).
              inArray(message.direction, ["in", "out"]),
              inArray(messagePart.status, [...STORED_STATUSES]),
            ),
          )
      : []
    if (uploads.length !== uploadIds.length || parts.length !== partIds.length)
      throw new Refusal("attachment_invalid", 400)
    const picked = [
      ...uploads.map((file) => ({ ...file, source: "upload" as const })),
      ...parts.map((file) => ({ ...file, source: "part" as const })),
    ]
    const byId = new Map(picked.map((file) => [file.id, file]))
    return [...uploadIds, ...partIds].flatMap((id) => {
      const file = byId.get(id)
      return file ? [{ ...file, fileName: cleanFileName(file.fileName ?? "file") }] : []
    })
  }

  /** A stored file's bytes, read by the server itself and checked against its hash. */
  async #bytes(hash: string): Promise<Buffer> {
    const bytes = await readFile(storedFilePath(this.filesDir, hash))
    if (sha256(bytes) !== hash) throw new Error("a stored file does not match its hash")
    return bytes
  }

  /**
   * A reply of a ticket in the scope, locked, with its outbox row; a refusal otherwise. The outbox row is locked first,
   * then the ticket FOR KEY SHARE (the order the sender's claim takes), and the scope is checked against the ticket as
   * that lock reads it: a move holds the ticket FOR UPDATE, so a move in progress is waited for and a ticket it took out
   * of the user's scope is not found (review S8). KEY SHARE, not a stronger lock: Mark as sent updates recipient rows
   * after this, and the webhook locks a recipient row before the ticket FOR NO KEY UPDATE, which KEY SHARE never blocks.
   */
  async #reply(tx: Pick<Db, "select">, scope: OrganizationScope, messageId: string) {
    const [row] = await tx
      .select({
        id: message.id,
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        number: ticket.number,
        state: outbox.state,
        actionId: outbox.actionId,
        actionVersion: outbox.actionVersion,
      })
      .from(message)
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .innerJoin(outbox, eq(outbox.messageId, message.id))
      .where(eq(message.id, messageId))
      .for("update", { of: outbox })
    if (!row || !inScope(scope, row.organizationId)) throw new Refusal("not_found", 404)
    const [held] = await tx
      .select({ organizationId: ticket.organizationId, status: ticket.status })
      .from(ticket)
      .where(eq(ticket.id, row.ticketId))
      .for("key share")
    if (!held || !inScope(scope, held.organizationId)) throw new Refusal("not_found", 404)
    await refuseImported(tx, row.ticketId)
    return { ...row, organizationId: held.organizationId, status: held.status as TicketStatus }
  }

  /**
   * "Send again": a reply whose fate is unknown, or that failed, goes to its recipients that were not accepted, once.
   * Only one locked change out of `unknown` or `failed` queues an attempt, so two clicks queue one.
   */
  async resend(scope: OrganizationScope, user: ReplyUser, messageId: string): Promise<void> {
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const row = await this.#reply(tx, scope, messageId)
      if (row.state !== "unknown" && row.state !== "failed") throw new Refusal("reply_not_retryable", 409)
      // A scheduled reply's message goes again only once its action passed the send point's check (plan 4.2): one that
      // a customer reply, a move, or a failed check ended before it went out is never sent by Send again.
      // An automatic reminder (plan 4.3) goes again only when no provider accepted it (never with an unknown fate) and
      // its waiting period still holds, as the claim checks it (the claim of the new attempt checks it once more).
      if (row.actionId) {
        const action = await lockAction(tx, row.actionId)
        const allowed =
          action?.kind === "reminder"
            ? await reminderMayGoAgain(tx, row, action, { id: row.ticketId, status: row.status })
            : action?.kind === "reply" && actionPassed(action, row.actionVersion)
        if (!allowed) throw new Refusal("reply_not_retryable", 409)
      }
      await tx
        .update(outboxRecipient)
        .set({ state: "pending", updatedAt: new Date() })
        .where(and(eq(outboxRecipient.messageId, messageId), sql`${outboxRecipient.state} <> 'accepted'`))
      await tx
        .update(outbox)
        .set({ state: "pending", problem: null, updatedAt: new Date() })
        .where(eq(outbox.messageId, messageId))
      await this.jobs.sendIn(jobs, SEND_REPLY, { messageId })
      await writeAudit(tx, user.actor, {
        action: "message.resend",
        entityType: "message",
        entityId: messageId,
        details: { ticket: row.number },
        ipAddress: user.ipAddress,
      })
    })
  }

  /**
   * "Mark as sent": the agent decides that one recipient whose fate is unknown received the reply (review R4: an
   * unknown recipient may also be one the server refused before the connection dropped, which nodemailer does not
   * report on a failed send, so the agent decides per recipient). The reply's state then follows its recipients.
   */
  async markSent(scope: OrganizationScope, user: ReplyUser, messageId: string, address: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.#reply(tx, scope, messageId)
      if (row.state !== "unknown") throw new Refusal("reply_not_unknown", 409)
      const marked = await tx
        .update(outboxRecipient)
        .set({ state: "accepted", markedBy: user.id, acceptedAt: sql`now()`, updatedAt: new Date() })
        .where(
          and(
            eq(outboxRecipient.messageId, messageId),
            eq(outboxRecipient.address, address.trim().toLowerCase()),
            eq(outboxRecipient.state, "unknown"),
          ),
        )
        .returning({ address: outboxRecipient.address, name: outboxRecipient.name })
      if (marked.length === 0) throw new Refusal("reply_not_unknown", 409)
      // Accepted by the agent's decision: they become participants, as a recipient a provider accepted does.
      if (marked.length)
        await tx
          .insert(ticketParticipant)
          .values(marked.map((entry) => ({ ticketId: row.ticketId, address: entry.address, name: entry.name })))
          .onConflictDoNothing()
      // An accepted reply may clear the ticket's delivery flag (plan 3.3).
      await refreshDeliveryFlag(tx, row.ticketId)
      const states = await tx
        .select({ state: outboxRecipient.state })
        .from(outboxRecipient)
        .where(eq(outboxRecipient.messageId, messageId))
      const settled = outboxStateOf(
        states.map((entry) => entry.state),
        true,
      )
      await tx
        .update(outbox)
        .set({ state: settled.state, problem: settled.problem, updatedAt: new Date() })
        .where(eq(outbox.messageId, messageId))
      await writeAudit(tx, user.actor, {
        action: "message.mark_sent",
        entityType: "message",
        entityId: messageId,
        details: { ticket: row.number, recipients: marked.map((entry) => entry.address) },
        ipAddress: user.ipAddress,
      })
    })
  }

  /** Keeps an uploaded file until the worker scanned it, and queues the scan in the same transaction. */
  async upload(user: ReplyUser, file: { name: string; type: string; bytes: Buffer }): Promise<UploadView> {
    const limit = await this.settings.get("files.maxBytes")
    if (file.bytes.byteLength > limit) throw new Refusal("file_too_large", 400, { max: limit })
    const fileName = cleanFileName(file.name)
    const declaredType = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type.toLowerCase().slice(0, 127) : null
    return transactionWithJobs(this.db, async (tx, jobs) => {
      const [row] = await tx
        .insert(upload)
        .values({ userId: user.id, fileName, declaredType, size: file.bytes.byteLength, content: file.bytes })
        .returning({ id: upload.id })
      if (!row) throw new Error("the upload was not written")
      await this.jobs.sendIn(jobs, UPLOAD_SCAN, { uploadId: row.id })
      return {
        id: row.id,
        fileName,
        size: file.bytes.byteLength,
        status: "scanning",
        signature: null,
        blockedBy: null,
      }
    })
  }

  /** One of the user's own uploads, or null. */
  async uploadView(userId: string, id: string): Promise<UploadView | null> {
    const [row] = await this.db
      .select({
        id: upload.id,
        fileName: upload.fileName,
        size: upload.size,
        status: upload.status,
        signature: upload.signature,
        blockedBy: upload.blockedBy,
      })
      .from(upload)
      .where(and(eq(upload.id, id), eq(upload.userId, userId)))
    return row ? { ...row, status: row.status as UploadView["status"] } : null
  }
}
