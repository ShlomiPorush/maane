// The email of a reply (plan 3.1, the basic email; the full layout is plan 3.2): an HTML part and a text part, each
// with the ticket's reference code line at the top (isolated left to right, so it never flips inside Hebrew), then the
// reply, then the organization's signature; `In-Reply-To` and `References` to the conversation; `[#n]` in the subject.
// nodemailer's MailComposer builds the MIME from data only: file and URL access are off, and every attachment is bytes
// the server read itself. The message is built once, when the agent sends it; a resend sends the same bytes.

import { randomUUID } from "node:crypto"
import { convert } from "html-to-text"
import MailComposer from "nodemailer/lib/mail-composer"
import { textDirection } from "../mail/bidi.ts"

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
  /** The reference line: its label in the organization's language, and the ticket's code. */
  referenceLabel: string
  referenceCode: string
  /** The reply as stored: sanitized HTML and its text. */
  html: string
  text: string
  signature: string
  /** The direction of a message without a strong character of its own: the default language's. */
  fallbackDirection: "rtl" | "ltr"
  attachments: ReplyAttachment[]
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** The text of sanitized HTML, for the text part and the stored text (html-to-text, as intake uses it). */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim()
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

/** The direction of the whole message: its text's first strong character, else the default language's. */
const directionOf = (mail: ReplyMail) => textDirection(mail.text) ?? mail.fallbackDirection

/** The reply's MIME, built once. */
export async function buildReply(mail: ReplyMail): Promise<Buffer> {
  const dir = directionOf(mail)
  const reference =
    `<p dir="${dir}" style="margin:0 0 12px;font-size:12px;color:#6b7280">` +
    `${escapeHtml(mail.referenceLabel)}: <span dir="ltr">${escapeHtml(mail.referenceCode)}</span></p>`
  const html =
    `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"></head>` +
    `<body dir="${dir}">${reference}${mail.html}${signatureHtml(mail.signature, dir)}</body></html>`
  const signatureText = mail.signature.trim() ? `\n\n-- \n${mail.signature.replace(/\r\n?/g, "\n")}` : ""
  const text = `${mail.referenceLabel}: ${mail.referenceCode}\n\n${mail.text}${signatureText}\n`
  const composer = new MailComposer({
    from: mail.from,
    to: mail.to.map((entry) => (entry.name ? { address: entry.address, name: entry.name } : entry.address)),
    cc: mail.cc.length
      ? mail.cc.map((entry) => (entry.name ? { address: entry.address, name: entry.name } : entry.address))
      : undefined,
    subject: mail.subject,
    messageId: `<${mail.messageId}>`,
    date: mail.date,
    inReplyTo: mail.inReplyTo ? `<${mail.inReplyTo}>` : undefined,
    references: mail.references.length ? mail.references.map((id) => `<${id}>`) : undefined,
    text,
    html,
    attachments: mail.attachments.map((file) => ({
      filename: file.fileName,
      content: file.content,
      contentType: file.contentType,
    })),
    disableFileAccess: true,
    disableUrlAccess: true,
    newline: "win",
  })
  return composer.compile().build()
}
