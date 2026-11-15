// Writing a reply or an internal note that is already built (plan 3.1), in the caller's transaction: the message, its
// parts, and for a reply its outbox row, recipients, links, and the `send-reply` job. The server writes a reply sent at
// once with it; the worker writes a scheduled reply at its time with it (plan 4.2), from the version the server built.
// Kept apart from the reply service so the worker never loads sharp. The ticket's status, its last activity, and the
// audit row are the caller's.

import type { MailAddress } from "@maane/shared"
import type { Db } from "../db/client.ts"
import { message, messagePart, outbox, outboxRecipient, trackedLink } from "../db/schema.ts"
import type { NewLink } from "../links/service.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** A file a reply attaches: the agent's upload or a file of the ticket's own messages, read and checked already. */
export type ReplyFile = { fileName: string; contentType: string; size: number; sha256: string; status: string }

/** The built email of a reply: its MIME (built once), its Message-ID, subject, and where it sits in the thread. */
export type BuiltReply = {
  mime: Buffer
  messageId: string
  subject: string
  inReplyTo: string | null
  references: string[]
}

/** A reply or a note, ready to write. A note has no From, recipients, built email, or links. */
export type ReadyMessage = {
  kind: "reply" | "note"
  from: string | null
  to: MailAddress[]
  cc: MailAddress[]
  /** The body as the ticket view keeps it: the agent's text and, for a reply, the organization's signature. */
  html: string
  text: string
  files: ReplyFile[]
  built: BuiltReply | null
  links: NewLink[]
}

/**
 * Writes the message and, for a reply, what sends it, and queues the send through `queueSend` (in the same
 * transaction). Returns the message's ID, or null when the same submission was written already (nothing more is written
 * then); throws ActionWritten when the same timed action's version made its outbox row already.
 */
export async function writeMessage(
  tx: Pick<Tx, "insert">,
  input: {
    ticketId: string
    authorUserId: string
    /** The composer's submission ID (a scheduled reply's own at its time). */
    submissionId: string
    at: Date
    ready: ReadyMessage
    action?: { id: string; version: number }
  },
  queueSend: (data: { messageId: string }) => Promise<unknown>,
): Promise<string | null> {
  const { ready } = input
  const isReply = ready.kind === "reply"
  const [row] = await tx
    .insert(message)
    .values({
      direction: isReply ? "out" : "note",
      ticketId: input.ticketId,
      receivedAt: input.at,
      sentAt: isReply ? input.at : null,
      state: "processed",
      processedAt: input.at,
      content: "parsed",
      authorUserId: input.authorUserId,
      submissionId: input.submissionId,
      messageIdHeader: ready.built?.messageId ?? null,
      inReplyTo: ready.built?.inReplyTo ? [ready.built.inReplyTo] : [],
      references: ready.built?.references ?? [],
      fromAddress: ready.from,
      toAddresses: ready.to,
      ccAddresses: ready.cc,
      subject: ready.built?.subject ?? null,
      textBody: ready.text,
      htmlBody: ready.html,
      createdAt: input.at,
    })
    .onConflictDoNothing()
    .returning({ id: message.id })
  // The same submission committed meanwhile: nothing more is written.
  if (!row) return null
  if (ready.files.length)
    await tx.insert(messagePart).values(
      ready.files.map((file, index) => ({
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
  if (!isReply || !ready.built || !ready.from) return row.id
  const [made] = await tx
    .insert(outbox)
    .values({
      messageId: row.id,
      mime: ready.built.mime,
      messageIdHeader: ready.built.messageId,
      fromAddress: ready.from,
      actionId: input.action?.id ?? null,
      actionVersion: input.action?.version ?? null,
    })
    .onConflictDoNothing({ target: [outbox.actionId, outbox.actionVersion] })
    .returning({ messageId: outbox.messageId })
  // This action's version made its row already: the whole write is undone by the caller (it throws).
  if (!made) throw new ActionWritten()
  await tx.insert(outboxRecipient).values([
    ...ready.to.map((entry, position) => ({ messageId: row.id, ...entry, kind: "to", position })),
    ...ready.cc.map((entry, position) => ({
      messageId: row.id,
      ...entry,
      kind: "cc",
      position: ready.to.length + position,
    })),
  ])
  if (ready.links.length)
    await tx
      .insert(trackedLink)
      .values(
        ready.links.map((link) =>
          link.kind === "url"
            ? { messageId: row.id, code: link.code, kind: link.kind, url: link.url }
            : { messageId: row.id, code: link.code, kind: link.kind, partId: link.partId },
        ),
      )
  await queueSend({ messageId: row.id })
  return row.id
}

/** A timed action's version already has its outbox row: a rerun makes no second message. */
export class ActionWritten extends Error {
  constructor() {
    super("this timed action's version already made its reply")
  }
}
