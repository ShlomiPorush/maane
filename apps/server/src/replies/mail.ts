// The email of a reply (plan 3.1, with the layout of plan 3.2 in layout.ts): an HTML part and a text part, the header
// and the reference code line first, the reply as a conversation block with the organization's signature, the public
// history quoted below; `In-Reply-To` and `References` to the conversation; `[#n]` in the subject. History images go
// as embedded parts (CID) in multipart/related, the reply's files as attachments. nodemailer's MailComposer builds the
// MIME from data only: file and URL access are off, and every attachment is bytes the server read itself. The message
// is built once, when the agent sends it; a resend sends the same bytes.
//
// Size (requirements 4.1 and 4.3): the reference code is at the top, so it is never clipped. The HTML part is kept
// under Gmail's clip budget by shortening the oldest history messages to their first words, then leaving the oldest
// out; the whole encoded message is kept under the provider's limit (MESSAGE_MAX_BYTES) by showing history images by
// their names, then shortening history; if the reply's own files still make it larger, it is refused (MessageTooLarge)
// before anything is written or queued.

import { randomUUID } from "node:crypto"
import { MESSAGE_MAX_BYTES } from "@maane/shared"
import MailComposer from "nodemailer/lib/mail-composer"
import { textDirection } from "../mail/bidi.ts"
import { type Conversation, type Entry, escapeHtml, layout, type MailWords, type Trim } from "./layout.ts"

export { htmlToText } from "./layout.ts"

/**
 * Gmail clips a message whose HTML is larger than about 102 KB (requirements 4.1); the HTML part is kept under this
 * many bytes of UTF-8 (a Hebrew letter is two), which leaves room for the encoding's line breaks.
 */
export const GMAIL_HTML_BUDGET = 100_000

export interface ReplyAttachment {
  fileName: string
  /** The type read from the content when the file was stored. */
  contentType: string
  content: Buffer
}

export interface ReplyMail {
  from: { address: string; name: string }
  to: { address: string; name: string | null }[]
  cc: { address: string; name: string | null }[]
  subject: string
  /** Without angle brackets. */
  messageId: string
  inReplyTo: string | null
  references: string[]
  date: Date
  /** The words of the layout in the default language, and the language. */
  words: MailWords
  lang: string
  referenceCode: string
  /** The agent's own name, for the initials. */
  authorName: string
  /** The reply as stored: sanitized HTML with the signature, and its text with the signature. */
  html: string
  text: string
  /** The direction of a message without a strong character of its own: the default language's. */
  fallbackDirection: "rtl" | "ltr"
  attachments: ReplyAttachment[]
  /** The public history, newest first: incoming messages and replies at least one recipient accepted. */
  history: Entry[]
}

/** The reply's message is larger than the provider takes, even with its history trimmed. */
export class MessageTooLarge extends Error {
  constructor(readonly size: number) {
    super("the message is larger than the provider takes")
    this.name = "MessageTooLarge"
  }
}

/** The reply alone (its HTML with no history left) is larger than Gmail's budget: Gmail would clip it. */
export class ReplyTooLong extends Error {
  constructor(readonly size: number) {
    super("the reply alone is larger than the HTML budget")
    this.name = "ReplyTooLong"
  }
}

/** The subject of a reply: the ticket's, with `Re:` once and `[#n]` once. */
export function replySubject(subject: string | null, number: number): string {
  const tag = `[#${number}]`
  const base = (subject ?? "").trim()
  const tagged = base.includes(tag) ? base : `${base} ${tag}`.trim()
  return /^re:/i.test(tagged) ? tagged : `Re: ${tagged}`
}

/** A new Message-ID for a reply from this address, without angle brackets: random, in the From address's domain. */
export function newMessageId(from: string): string {
  return `${randomUUID()}@${from.slice(from.lastIndexOf("@") + 1)}`
}

/** The signature as HTML: one block per line, each with its own direction, escaped. */
export function signatureHtml(signature: string, dir: "rtl" | "ltr"): string {
  const lines = signature.replace(/\r\n?/g, "\n").split("\n")
  if (signature.trim() === "") return ""
  const inner = lines
    .map((line) => `<div dir="${textDirection(line) ?? dir}">${line.trim() === "" ? "<br>" : escapeHtml(line)}</div>`)
    .join("")
  return `<div style="margin-top:16px">${inner}</div>`
}

/** What the ticket view keeps of a reply or a note: the agent's text and the signature, without the reference line. */
export function storedBody(html: string, text: string, signature: string): { html: string; text: string } {
  const dir = textDirection(text) ?? "ltr"
  const sig = signature.trim()
  return {
    html: sig ? `${html}${signatureHtml(signature, dir)}` : html,
    text: sig ? `${text}\n\n-- \n${signature}` : text,
  }
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8")

/** The conversation the layout draws. The email's direction is the reply's own, else the default language's. */
function conversationOf(mail: ReplyMail): Conversation {
  return {
    dir: textDirection(mail.text) ?? mail.fallbackDirection,
    lang: mail.lang,
    words: mail.words,
    referenceCode: mail.referenceCode,
    current: {
      name: mail.from.name,
      initialsOf: mail.authorName,
      at: mail.date,
      html: mail.html,
      text: mail.text,
      images: new Map(),
      files: [],
    },
    history: mail.history,
  }
}

/**
 * The lowest trim level whose HTML fits Gmail's budget, or the last one (all history left out). The HTML only shrinks
 * as the level rises, so the level is found by bisection.
 */
function gmailTrim(conversation: Conversation, budget: number, imageNames: boolean, from = 0): Trim {
  const fits = (level: number) => utf8Bytes(layout(conversation, { level, imageNames }).html) <= budget
  let low = from
  let high = Math.max(from, conversation.history.length * 2)
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) high = middle
    else low = middle + 1
  }
  return { level: low, imageNames }
}

async function compose(mail: ReplyMail, conversation: Conversation, trim: Trim): Promise<Buffer> {
  const built = layout(conversation, trim)
  const address = (entry: { address: string; name: string | null }) =>
    entry.name ? { address: entry.address, name: entry.name } : entry.address
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to.map(address),
    cc: mail.cc.length ? mail.cc.map(address) : undefined,
    subject: mail.subject,
    messageId: `<${mail.messageId}>`,
    date: mail.date,
    inReplyTo: mail.inReplyTo ? `<${mail.inReplyTo}>` : undefined,
    references: mail.references.length ? mail.references.map((id) => `<${id}>`) : undefined,
    text: built.text,
    html: built.html,
    attachments: [
      ...mail.attachments.map((file) => ({
        filename: file.fileName,
        content: file.content,
        contentType: file.contentType,
      })),
      // Embedded history images: nodemailer puts an attachment with a cid into multipart/related with the HTML.
      ...built.images.map((image) => ({
        filename: image.fileName,
        content: image.content,
        contentType: image.contentType,
        cid: image.cid,
        contentDisposition: "inline" as const,
      })),
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
    newline: "win",
  })
  return composer.compile().build()
}

/** The budgets a message is built within: the HTML part's bytes and the whole message's. */
export interface Budget {
  html: number
  message: number
}

export const BUDGET: Budget = { html: GMAIL_HTML_BUDGET, message: MESSAGE_MAX_BYTES }

/**
 * The reply's MIME, built once, within the budgets above. After every trim the HTML is measured again: when even the
 * reply alone, with no history left, is over Gmail's budget, it is refused (ReplyTooLong), as a message over the
 * provider's limit is (MessageTooLarge).
 */
export async function buildReply(mail: ReplyMail, budget: Budget = BUDGET): Promise<Buffer> {
  const conversation = conversationOf(mail)
  const count = conversation.history.length
  let trim = gmailTrim(conversation, budget.html, false)
  let mime = await compose(mail, conversation, trim)
  if (mime.length > budget.message) {
    // History images by their names first (the HTML is measured again: a name can be longer than its image tag), then
    // history in short form, then without it.
    trim = gmailTrim(conversation, budget.html, true, trim.level)
    mime = await compose(mail, conversation, trim)
    for (const level of [count, count * 2]) {
      if (mime.length <= budget.message || trim.level >= level) continue
      trim = { level, imageNames: true }
      mime = await compose(mail, conversation, trim)
    }
  }
  const html = utf8Bytes(layout(conversation, trim).html)
  if (html > budget.html) throw new ReplyTooLong(html)
  if (mime.length > budget.message) throw new MessageTooLarge(mime.length)
  return mime
}
