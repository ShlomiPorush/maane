import type { MailAddress } from "@maane/shared"
import type { Db } from "../db/client.ts"
import { message, messagePart, outbox, outboxRecipient, trackedLink } from "../db/schema.ts"
import type { NewLink } from "../links/service.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type ReplyFile = { fileName: string; contentType: string; size: number; sha256: string; status: string }

export type BuiltReply = {
  mime: Buffer
  messageId: string
  subject: string
  inReplyTo: string | null
  references: string[]
}

export type ReadyMessage = {
  kind: "reply" | "note"
  from: string | null
  to: MailAddress[]
  cc: MailAddress[]
  html: string
  text: string
  files: ReplyFile[]
  built: BuiltReply | null
  links: NewLink[]
}

export async function writeMessage(
  tx: Pick<Tx, "insert">,
  input: {
    ticketId: string
    authorUserId: string | null
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
  await tx.insert(outbox).values({
    messageId: row.id,
    mime: ready.built.mime,
    messageIdHeader: ready.built.messageId,
    fromAddress: ready.from,
    actionId: input.action?.id ?? null,
    actionVersion: input.action?.version ?? null,
  })
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
