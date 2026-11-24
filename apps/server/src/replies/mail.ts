import { randomUUID } from "node:crypto"
import { MESSAGE_MAX_BYTES } from "@maane/shared"
import MailComposer from "nodemailer/lib/mail-composer"
import { textDirection } from "../mail/bidi.ts"
import { type Conversation, type Entry, escapeHtml, layout, type MailWords, type Trim } from "./layout.ts"

export { htmlToText } from "./layout.ts"

export const GMAIL_HTML_BUDGET = 100_000

export interface ReplyAttachment {
  fileName: string
  contentType: string
  content: Buffer
}

export interface ReplyMail {
  from: { address: string; name: string }
  to: { address: string; name: string | null }[]
  cc: { address: string; name: string | null }[]
  subject: string
  messageId: string
  inReplyTo: string | null
  references: string[]
  date: Date
  words: MailWords
  lang: string
  referenceCode: string
  authorName: string
  html: string
  text: string
  fallbackDirection: "rtl" | "ltr"
  attachments: ReplyAttachment[]
  history: Entry[]
  link?: (href: string) => string
  headers?: Record<string, string>
}

export class MessageTooLarge extends Error {
  constructor(readonly size: number) {
    super("the message is larger than the provider takes")
    this.name = "MessageTooLarge"
  }
}

export class ReplyTooLong extends Error {
  constructor(readonly size: number) {
    super("the reply alone is larger than the HTML budget")
    this.name = "ReplyTooLong"
  }
}

export function replySubject(subject: string | null, number: number): string {
  const tag = `[#${number}]`
  const base = (subject ?? "").trim()
  const tagged = base.includes(tag) ? base : `${base} ${tag}`.trim()
  return /^re:/i.test(tagged) ? tagged : `Re: ${tagged}`
}

export function newMessageId(from: string): string {
  return `${randomUUID()}@${from.slice(from.lastIndexOf("@") + 1)}`
}

export function plainTextHtml(text: string, dir: "rtl" | "ltr"): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<div dir="${textDirection(line) ?? dir}">${line.trim() === "" ? "<br>" : escapeHtml(line)}</div>`)
    .join("")
}

export function signatureHtml(signature: string, dir: "rtl" | "ltr"): string {
  if (signature.trim() === "") return ""
  return `<div style="margin-top:16px">${plainTextHtml(signature, dir)}</div>`
}

export function storedBody(html: string, text: string, signature: string): { html: string; text: string } {
  const dir = textDirection(text) ?? "ltr"
  const sig = signature.trim()
  return {
    html: sig ? `${html}${signatureHtml(signature, dir)}` : html,
    text: sig ? `${text}\n\n-- \n${signature}` : text,
  }
}

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8")

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
      link: mail.link,
    },
    history: mail.history,
  }
}

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
      ...built.images.map((image) => ({
        filename: image.fileName,
        content: image.content,
        contentType: image.contentType,
        cid: image.cid,
        contentDisposition: "inline" as const,
      })),
    ],
    ...(mail.headers ? { headers: mail.headers } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
    newline: "win",
  })
  return composer.compile().build()
}

export interface Budget {
  html: number
  message: number
}

export const BUDGET: Budget = { html: GMAIL_HTML_BUDGET, message: MESSAGE_MAX_BYTES }

export async function buildReply(mail: ReplyMail, budget: Budget = BUDGET): Promise<Buffer> {
  const conversation = conversationOf(mail)
  const count = conversation.history.length
  let trim = gmailTrim(conversation, budget.html, false)
  let mime = await compose(mail, conversation, trim)
  if (mime.length > budget.message) {
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
