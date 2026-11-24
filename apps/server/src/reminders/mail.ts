import { type ActionReason, type Locale, type MailAddress, MESSAGES } from "@maane/shared"
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { message, organization, ticket, ticketParticipant } from "../db/schema.ts"
import { textDirection } from "../mail/bidi.ts"
import { buildReply, newMessageId, plainTextHtml, replySubject } from "../replies/mail.ts"
import { fromAddresses, supportRules } from "../replies/rules.ts"
import type { ReadyMessage } from "../replies/write.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export const AUTO_SUBMITTED = { "Auto-Submitted": "auto-generated" } as const

export async function reminderMessage(
  tx: Pick<Tx, "select">,
  ticketId: string,
  locale: Locale,
  at: Date,
): Promise<ReadyMessage | Extract<ActionReason, "no_template" | "from_not_allowed" | "no_recipients">> {
  const [row] = await tx
    .select({
      number: ticket.number,
      subject: ticket.subject,
      referenceCode: ticket.referenceCode,
      supportAddress: ticket.supportAddress,
      organizationId: ticket.organizationId,
      name: organization.name,
      template: organization.reminderTemplate,
    })
    .from(ticket)
    .innerJoin(organization, eq(organization.id, ticket.organizationId))
    .where(eq(ticket.id, ticketId))
  if (!row || row.template.trim() === "") return "no_template"
  const from = fromAddresses(await supportRules(tx), row.organizationId, row.supportAddress).defaultFrom
  if (!from) return "from_not_allowed"
  const participants = await tx
    .select({ address: ticketParticipant.address, name: ticketParticipant.name })
    .from(ticketParticipant)
    .where(eq(ticketParticipant.ticketId, ticketId))
    .orderBy(asc(ticketParticipant.createdAt), asc(ticketParticipant.address))
  const [first, ...others] = participants as MailAddress[]
  if (!first) return "no_recipients"
  const [parent] = await tx
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
  const inReplyTo = parent?.id ?? null
  const references = parent?.id ? [...parent.references.slice(-20), parent.id] : []
  const messageId = newMessageId(from)
  const subject = replySubject(row.subject, row.number)
  const fallbackDirection = locale === "he" ? "rtl" : "ltr"
  const text = row.template
  const html = plainTextHtml(text, textDirection(text) ?? fallbackDirection)
  const mime = await buildReply({
    from: { address: from, name: row.name },
    to: [first],
    cc: others,
    subject,
    messageId,
    inReplyTo,
    references,
    date: at,
    words: MESSAGES[locale].mail,
    lang: locale,
    referenceCode: row.referenceCode,
    authorName: row.name,
    html,
    text,
    fallbackDirection,
    attachments: [],
    history: [],
    headers: { ...AUTO_SUBMITTED },
  })
  return {
    kind: "reply",
    from,
    to: [first],
    cc: others,
    html,
    text,
    files: [],
    built: { mime, messageId, subject, inReplyTo, references },
    links: [],
  }
}
