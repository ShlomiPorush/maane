// Replies and internal notes (plan 3.1): what the composer starts from, writing a reply or a note, the uploads it
// attaches, and the agent's decision about a reply whose fate is unknown. The server never sends: it builds the
// message once, writes it with its outbox row, its recipients, and the queue job that sends it in one transaction, and
// the worker sends it. Every query takes the user's scope (visibleOrganizations, read on each request).
//
// One reply per click: the composer sends a submission ID, and a unique index on (author, submission ID) makes a
// repeated or lost request find the same message. Only the ticket's own files and the user's own uploads can be
// attached, and the server reads their bytes itself. The From address must belong to the ticket's organization, and
// the send point refuses a reply while intake listens (the worker checks both again when it sends).

import { createHash, randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  ADDRESS_MAX,
  ATTACHABLE_UPLOAD_STATUSES,
  ATTACHMENTS_MAX,
  type ComposeView,
  type MailAddress,
  MESSAGE_MAX_BYTES,
  MESSAGES,
  outboxStateOf,
  parseExactAddress,
  RECIPIENTS_MAX,
  REPLY_HTML_MAX,
  STORED_STATUSES,
  type UploadView,
} from "@maane/shared"
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import { z } from "zod"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import {
  authUser,
  message,
  messagePart,
  organization,
  outbox,
  outboxRecipient,
  storedFile,
  ticket,
  ticketParticipant,
  upload,
} from "../db/schema.ts"
import { storedFilePath } from "../files/paths.ts"
import { type JobQueue, SEND_REPLY, transactionWithJobs, UPLOAD_SCAN } from "../jobs/queue.ts"
import { sanitizeMailHtml } from "../mail/html.ts"
import { Refusal } from "../organizations/refusal.ts"
import { inScope, type OrganizationScope } from "../organizations/scope.ts"
import type { Settings } from "../settings/service.ts"
import { wellFormedText } from "../text.ts"
import { INLINE_IMAGE_MAX_BYTES, INLINE_IMAGES_MAX_BYTES } from "../tickets/service.ts"
import { EMBEDDABLE_TYPES, prepareImage } from "./images.ts"
import type { Entry, EntryImage } from "./layout.ts"
import {
  buildReply,
  htmlToText,
  MessageTooLarge,
  newMessageId,
  type ReplyAttachment,
  replySubject,
  storedBody,
} from "./mail.ts"
import { belongsTo, supportRules } from "./rules.ts"

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
})
export type ReplyBodyInput = z.infer<typeof ReplyBody>

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
  async #ticket(scope: OrganizationScope, number: number) {
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
    const rules = await supportRules(this.db)
    const own = rules
      .filter((rule) => rule.kind === "exact" && rule.organizationId === found.organizationId)
      .map((rule) => rule.value)
      .sort()
    const ticketAddress = belongsTo(found.supportAddress, rules, found.organizationId) ? found.supportAddress : null
    const from = ticketAddress && !own.includes(ticketAddress) ? [ticketAddress, ...own] : own
    const participants = await this.db
      .select({ address: ticketParticipant.address, name: ticketParticipant.name })
      .from(ticketParticipant)
      .where(eq(ticketParticipant.ticketId, found.id))
      .orderBy(asc(ticketParticipant.createdAt), asc(ticketParticipant.address))
    const [first, ...others] = participants
    return {
      from,
      defaultFrom: ticketAddress ?? from[0] ?? null,
      to: first ? [first] : [],
      cc: others,
      signature,
      senderName: `${await this.#agentName(userId)} (${organizationName})`,
      listening: (await this.settings.get("intake.mode")) === "listening",
    }
  }

  /**
   * Writes a reply (with its outbox row, recipients, and send job) or an internal note, once per submission ID.
   * Returns the message's ID; the same ID again for a repeated submission.
   */
  async submit(
    scope: OrganizationScope,
    user: ReplyUser,
    number: number,
    input: ReplyBodyInput,
  ): Promise<{ id: string }> {
    const existing = await this.#submitted(user.id, input.submissionId)
    if (existing) return existing
    const found = await this.#ticket(scope, number)
    if (!found) throw new Refusal("not_found", 404)
    const t = found.ticket
    const isReply = input.kind === "reply"

    let from: string | null = null
    let people: { to: MailAddress[]; cc: MailAddress[] } = { to: [], cc: [] }
    if (isReply) {
      // The send point refuses customer replies while intake listens; the worker checks again under the mode's lock.
      if ((await this.settings.get("intake.mode")) === "listening") throw new Refusal("listening_mode", 409)
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

    const now = new Date()
    let built: {
      mime: Buffer
      messageId: string
      subject: string
      inReplyTo: string | null
      references: string[]
    } | null = null
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
      const history = await this.#history(t.id, found.organizationName, from)
      const mime = await buildReply({
        from: { address: from, name: `${authorName} (${found.organizationName})` },
        to: people.to,
        cc: people.cc,
        subject,
        messageId,
        inReplyTo: parent?.id ?? null,
        references,
        date: now,
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
      }).catch((error: unknown) => {
        // Refused before anything is written or queued (plan 3.2).
        if (error instanceof MessageTooLarge) throw new Refusal("message_too_large", 400, { max: MESSAGE_MAX_BYTES })
        throw error
      })
      built = { mime, messageId, subject, inReplyTo: parent?.id ?? null, references }
    }

    const written = await transactionWithJobs(this.db, async (tx, jobs) => {
      const [row] = await tx
        .insert(message)
        .values({
          direction: isReply ? "out" : "note",
          ticketId: t.id,
          receivedAt: now,
          sentAt: isReply ? now : null,
          state: "processed",
          processedAt: now,
          content: "parsed",
          authorUserId: user.id,
          submissionId: input.submissionId,
          messageIdHeader: built?.messageId ?? null,
          inReplyTo: built?.inReplyTo ? [built.inReplyTo] : [],
          references: built?.references ?? [],
          fromAddress: from,
          toAddresses: people.to,
          ccAddresses: people.cc,
          subject: built?.subject ?? null,
          textBody: body.text,
          htmlBody: body.html,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: message.id })
      // The same submission committed meanwhile: nothing more is written, and its message is returned below.
      if (!row) return null
      if (files.length)
        await tx.insert(messagePart).values(
          files.map((file, index) => ({
            messageId: row.id,
            index,
            kind: "attachment",
            fileName: file.fileName,
            declaredType: file.contentType,
            size: file.size,
            sha256: file.sha256,
            status: file.status,
            storedSha256: file.sha256,
          })),
        )
      if (built && from) {
        await tx.insert(outbox).values({
          messageId: row.id,
          mime: built.mime,
          messageIdHeader: built.messageId,
          fromAddress: from,
        })
        await tx.insert(outboxRecipient).values([
          ...people.to.map((entry, position) => ({ messageId: row.id, ...entry, kind: "to", position })),
          ...people.cc.map((entry, position) => ({
            messageId: row.id,
            ...entry,
            kind: "cc",
            position: people.to.length + position,
          })),
        ])
        await this.jobs.sendIn(jobs, SEND_REPLY, { messageId: row.id })
      }
      await tx
        .update(ticket)
        .set(isReply ? { status: "open", lastActivityAt: now } : { lastActivityAt: now })
        .where(eq(ticket.id, t.id))
      await writeAudit(tx, user.actor, {
        action: isReply ? "message.reply" : "message.note",
        entityType: "message",
        entityId: row.id,
        details: {
          ticket: t.number,
          ...(isReply ? { from, recipients: [...people.to, ...people.cc].map((entry) => entry.address) } : {}),
          files: files.length,
        },
        ipAddress: user.ipAddress,
      })
      return { id: row.id }
    })
    if (written) return written
    const again = await this.#submitted(user.id, input.submissionId)
    if (!again) throw new Error("a submission that conflicted was not found")
    return again
  }

  async #submitted(userId: string, submissionId: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: message.id })
      .from(message)
      .where(and(eq(message.authorUserId, userId), eq(message.submissionId, submissionId)))
    return row ?? null
  }

  /**
   * The public history a reply quotes, newest first (requirements 4.1): the ticket's incoming messages and its replies
   * that at least one recipient accepted, never an internal note; each with its files' names and the images its HTML
   * embeds. An image is embedded only as the ticket view shows one: a part of the same message that scanned clean, its
   * stored file clean, with an image type, within the same sizes; prepared (downscaled) with sharp, with a new content
   * ID in the From address's domain. Every other image of the stored HTML is left out when the email is drawn.
   */
  async #history(ticketId: string, organizationName: string, from: string): Promise<Entry[]> {
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
          or(eq(message.direction, "in"), and(eq(message.direction, "out"), exists(accepted))),
        ),
      )
      .orderBy(desc(message.receivedAt), desc(message.createdAt))
    if (rows.length === 0) return []
    const parts = await this.db
      .select({
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

    const entries: Entry[] = []
    for (const row of rows) {
      const own = parts.filter((part) => part.messageId === row.id)
      const files = own
        .filter((part) => part.kind === "attachment" && part.sha256 && STORED.has(part.status))
        .map((part) => cleanFileName(part.fileName ?? "file"))
      const images = new Map<string, EntryImage>()
      let total = 0
      for (const part of own) {
        const id = part.contentId
        if (part.kind !== "inline" || !id || !part.sha256 || images.has(id) || !row.html?.includes(id)) continue
        if (part.status !== "clean" || part.storedStatus !== "clean") continue
        if (!EMBEDDABLE_TYPES.includes(part.detectedType as never) || (part.size ?? 0) > INLINE_IMAGE_MAX_BYTES)
          continue
        if (total + (part.size ?? 0) > INLINE_IMAGES_MAX_BYTES) continue
        const bytes = await this.#bytes(part.sha256).catch(() => null)
        const prepared = bytes ? await prepareImage(bytes, part.detectedType ?? "") : null
        if (!prepared) continue
        total += part.size ?? 0
        images.set(id, {
          ...prepared,
          cid: `${randomUUID()}@${domain}`,
          fileName: cleanFileName(part.fileName ?? "image"),
        })
      }
      const agent = row.authorUserId ? (names.get(row.authorUserId) ?? row.authorUserId) : null
      const customer = row.fromName?.trim() || row.fromAddress || "?"
      entries.push({
        name: agent ? `${agent} (${organizationName})` : customer,
        initialsOf: agent ?? customer,
        at: row.receivedAt,
        html: row.html !== null && row.html !== "" ? row.html : null,
        text: row.text !== null && row.text !== "" ? row.text : null,
        images,
        files,
      })
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
    input: ReplyBodyInput,
  ): Promise<{ fileName: string; contentType: string; size: number; sha256: string; status: string }[]> {
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
    const byId = new Map([...uploads, ...parts].map((file) => [file.id, file]))
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

  /** A reply of a ticket in the scope, locked, with its outbox row; a refusal otherwise. */
  async #reply(tx: Pick<Db, "select">, scope: OrganizationScope, messageId: string) {
    const [row] = await tx
      .select({
        id: message.id,
        ticketId: ticket.id,
        organizationId: ticket.organizationId,
        number: ticket.number,
        state: outbox.state,
      })
      .from(message)
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .innerJoin(outbox, eq(outbox.messageId, message.id))
      .where(eq(message.id, messageId))
      .for("update", { of: outbox })
    if (!row || !inScope(scope, row.organizationId)) throw new Refusal("not_found", 404)
    return row
  }

  /**
   * "Send again": a reply whose fate is unknown, or that failed, goes to its recipients that were not accepted, once.
   * Only one locked change out of `unknown` or `failed` queues an attempt, so two clicks queue one.
   */
  async resend(scope: OrganizationScope, user: ReplyUser, messageId: string): Promise<void> {
    if ((await this.settings.get("intake.mode")) === "listening") throw new Refusal("listening_mode", 409)
    await transactionWithJobs(this.db, async (tx, jobs) => {
      const row = await this.#reply(tx, scope, messageId)
      if (row.state !== "unknown" && row.state !== "failed") throw new Refusal("reply_not_retryable", 409)
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
        .set({ state: "accepted", markedBy: user.id, updatedAt: new Date() })
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
