// The layout of a customer's email (requirements 4.1, plan 3.2), by the owner's `html-email` rules: the header line
// (reply to this email to update the conversation) and the reference code line first, the code isolated left to right;
// the new message as a conversation block (an initials avatar made of a table cell, the name, the date and time in
// Israel time, the content); then an ordinary attribution line and the public history in `<blockquote type="cite">`,
// newest first, each message the same block. The text part has the same order.
//
// Direction: `dir` on the html, the body, and every table of the layout (Outlook on the web drops the first two), and
// on each paragraph of each message by the server's direction pass (mail/direction.ts), never dir="auto". Colours are
// neutral greys only, light inline, a dark-mode block, and descendant rules under Outlook's `data-ogsb` mark; links a
// mail client adds take the text's look, the links in a message keep their underline. Long strings break.
//
// Size (mail.ts decides): the oldest history messages can be shown in short form (their first words) or left out,
// and history images can show only their names.

import { convert } from "html-to-text"
import { textDirection } from "../mail/bidi.ts"
import { type Direction, directBlocks, messageDirection } from "../mail/direction.ts"
import { renderEmailHtml } from "../mail/html.ts"
import { COLUMN_WIDTH, type PreparedImage, shownSize } from "./images.ts"
import { wordCopies } from "./word.ts"

/** The words of the email, in the default language (he.json and en.json, `mail`). */
export interface MailWords {
  header: string
  reference: string
  /** With {date} and {name}. */
  attribution: string
  /** With {names}. */
  files: string
  /** With {count}. */
  olderOmitted: string
}

/** An image a message embeds: prepared, with the content ID the email gives it and its file name. */
export type EntryImage = PreparedImage & { cid: string; fileName: string }

/** One message of the conversation. */
export interface Entry {
  /** The name shown in its block. */
  name: string
  /** The name its initials come from (an agent's own name, without the organization). */
  initialsOf: string
  at: Date
  /** Stored, sanitized HTML (a reply's with its signature), or null. */
  html: string | null
  text: string | null
  /** The images it embeds, by the content ID its stored HTML refers to. */
  images: Map<string, EntryImage>
  /** The images it shows by their file names only (over the size budget, or unreadable), by content ID. */
  imageNames?: Map<string, string>
  /** Its files: their names, and their download links (history, plan 3.4; null without one). */
  files: readonly EntryFile[]
  /**
   * The address the email carries for an http or https link the message holds (a tracked link, plan 3.4); without it
   * links stay as they are. Only the new message has one: links in the quoted history are never tracked.
   */
  link?: (href: string) => string
}

/** A file a message names. */
export interface EntryFile {
  name: string
  href: string | null
}

export interface Conversation {
  /** The email's direction: the default language's, or the new message's own. */
  dir: Direction
  lang: string
  words: MailWords
  referenceCode: string
  current: Entry
  /** Newest first. */
  history: readonly Entry[]
}

/** How history is shown: `level` 0 is all of it; 1 to n shorten the oldest n; n+1 to 2n then leave the oldest out. */
export interface Trim {
  level: number
  imageNames: boolean
}

export type Form = "full" | "short" | "omitted"

/** The form of history message `index` (0 the newest) of `count` at a trim level. */
export function formOf(index: number, count: number, level: number): Form {
  const fromOldest = count - 1 - index
  if (fromOldest < level - count) return "omitted"
  if (fromOldest < level) return "short"
  return "full"
}

/** LEFT-TO-RIGHT ISOLATE and POP DIRECTIONAL ISOLATE (written as code points: no literal controls in the code). */
export const LRI = String.fromCodePoint(0x2066)
export const PDI = String.fromCodePoint(0x2069)

/** The characters a message in short form keeps. */
export const SHORT_CHARACTERS = 280

// Neutral greys only (html-email): light inline, dark in the block below.
const TEXT = "#222222"
const MUTED = "#666666"
const LINE = "#E0E0E0"
const AVATAR = "#EEEEEE"
const AVATAR_TEXT = "#333333"
const FONT = "Arial,Helvetica,sans-serif"
/** The history's indent: its start padding and its line. */
const QUOTE_INDENT = 14

const STYLE = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark}",
  // Links a mail client adds itself (dates, times, phone numbers) take the text's look; a message's own links keep
  // their underline inline with !important.
  ".email-bg a{color:inherit !important;text-decoration:none !important}",
  // A message's own tables and images (a customer's layout table 700 pixels wide) stay inside the column on a phone.
  ".email-content table{width:auto !important;max-width:100% !important}",
  ".email-content img{max-width:100% !important;height:auto !important}",
  "@media (prefers-color-scheme:dark){",
  ".email-body,.email-bg{background-color:#141414 !important}",
  ".email-text{color:#EEEEEE !important}",
  ".email-muted{color:#AAAAAA !important}",
  ".email-line{border-color:#333333 !important}",
  ".email-avatar{background-color:#333333 !important;color:#EEEEEE !important}",
  // A message's own colours (black text, white cells from Outlook) would read as a white slab or black on dark: in
  // dark mode its content takes the email's colours.
  ".email-content *{color:inherit !important;background-color:transparent !important;border-color:#333333 !important}",
  "}",
  // Outlook for Android marks what it recolours; descendant rules under the mark keep the surfaces neutral.
  "[data-ogsb] .email-bg{background-color:#FFFFFF !important}",
  "[data-ogsb] .email-avatar{background-color:#333333 !important}",
  "[data-ogsb] .email-line{border-color:#333333 !important}",
].join("")

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

/** A template's {names} filled in. */
export const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole)

const ISRAEL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Jerusalem",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** "13/11/2026 14:05": the date and time in Israel time, as numbers only, as the UI writes them. */
export function israelTime(date: Date): string {
  const parts = ISRAEL.formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`
}

/** One or two initials: the first letter of the first and of the last word. */
export function initials(name: string): string {
  const letters = name
    .split(/[\s@._-]+/)
    .map((word) => [...word].find((char) => /\p{L}/u.test(char)))
    .filter((letter): letter is string => letter !== undefined)
  const chosen = letters.length > 1 ? [letters[0], letters.at(-1)] : letters.slice(0, 1)
  return chosen.join("").toLocaleUpperCase("en") || "?"
}

/** The text of HTML, for the text part and the short form (html-to-text, as intake and 3.1 use it). */
export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
    ],
  }).trim()
}

const textOf = (entry: Entry) => entry.text ?? (entry.html ? htmlToText(entry.html) : "")

/** The first words of a message, on one line, cut between characters. */
export function shortText(entry: Entry): string {
  const flat = textOf(entry).replace(/\s+/g, " ").trim()
  const chars = [...flat]
  return chars.length > SHORT_CHARACTERS ? `${chars.slice(0, SHORT_CHARACTERS).join("").trimEnd()}...` : flat
}

const side = (dir: Direction) => (dir === "rtl" ? "right" : "left")
const otherSide = (dir: Direction) => (dir === "rtl" ? "left" : "right")
/** A piece of text in its own direction, isolated from the text around it. */
const isolated = (text: string, around: Direction) =>
  `<span dir="${textDirection(text) ?? around}">${escapeHtml(text)}</span>`

/** Text without HTML, line by line, each line with its own direction. */
function linesHtml(text: string, dir: Direction): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<div dir="${textDirection(line) ?? dir}">${line.trim() === "" ? "<br>" : escapeHtml(line)}</div>`)
    .join("")
}

/** A message's content as the email shows it, and the images it used. */
type Content = { html: string; dir: Direction; images: EntryImage[] }

/** Each message's content by its form, so trying several trims renders each message once. */
const rendered = new WeakMap<Entry, Map<string, Content>>()

function contentHtml(
  entry: Entry,
  form: Form,
  filesWord: string,
  column: number,
  imageNames: boolean,
  around: Direction,
  used: Map<string, EntryImage>,
): { html: string; dir: Direction } {
  const key = `${form} ${column} ${imageNames} ${around} ${filesWord}`
  const forEntry = rendered.get(entry) ?? new Map<string, Content>()
  rendered.set(entry, forEntry)
  const content = forEntry.get(key) ?? renderContent(entry, form, filesWord, column, imageNames, around)
  forEntry.set(key, content)
  for (const image of content.images) used.set(image.cid, image)
  return content
}

function renderContent(
  entry: Entry,
  form: Form,
  filesWord: string,
  column: number,
  imageNames: boolean,
  around: Direction,
): Content {
  const images: EntryImage[] = []
  // A message without a letter of its own (an image alone) takes the email's direction.
  const dir = messageDirection(entry.text, entry.html, around)
  if (form === "short") {
    const text = shortText(entry)
    // Word's own copy of a long run here too (html-email).
    const html = wordCopies(`<div dir="${textDirection(text) ?? dir}">${escapeHtml(text)}</div>`)
    return { html, dir, images }
  }
  let html = ""
  if (entry.html) {
    html = renderEmailHtml(
      directBlocks(entry.html, dir),
      (contentId) => {
        const image = entry.images.get(contentId)
        if (!image) {
          const name = entry.imageNames?.get(contentId)
          return name === undefined ? null : { name }
        }
        if (imageNames) return { name: image.fileName }
        images.push(image)
        return { cid: image.cid, ...shownSize(image, column) }
      },
      entry.link,
    )
  } else if (entry.text) html = linesHtml(entry.text, dir)
  if (entry.files.length)
    html +=
      `<div dir="${dir}" class="email-muted" style="margin-top:8px;font-size:12px;line-height:18px;color:${MUTED}">` +
      `${fileLine(filesWord, entry.files, dir)}</div>`
  // Word's own copy of a text with a run longer than the column (html-email).
  return { html: wordCopies(html), dir, images }
}

/**
 * The files line: the names, each isolated in its own direction, a name with a download link as that link (its underline
 * inline with !important, as html-email asks of the links an app makes).
 */
const fileLine = (filesWord: string, files: readonly EntryFile[], dir: Direction) => {
  const [before = "", after = ""] = filesWord.split("{names}")
  const names = files.map((file) =>
    file.href
      ? `<a href="${escapeHtml(file.href)}" style="text-decoration:underline !important">${isolated(file.name, dir)}</a>`
      : isolated(file.name, dir),
  )
  return `${escapeHtml(before)}${names.join(", ")}${escapeHtml(after)}`
}

/** One conversation block: the avatar cell, the name and the time, then the content. */
function blockHtml(
  entry: Entry,
  form: Form,
  words: MailWords,
  emailDir: Direction,
  column: number,
  imageNames: boolean,
  used: Map<string, EntryImage>,
) {
  const content = contentHtml(entry, form, words.files, column, imageNames, emailDir, used)
  const letters = initials(entry.initialsOf)
  return (
    `<table role="presentation" dir="${emailDir}" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;border-collapse:collapse">` +
    `<tr><td width="48" valign="top" style="width:48px;padding-${otherSide(emailDir)}:12px">` +
    `<table role="presentation" dir="${emailDir}" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="email-avatar" dir="${textDirection(letters) ?? emailDir}" width="36" height="36" align="center" ` +
    `valign="middle" bgcolor="${AVATAR}" style="width:36px;height:36px;border-radius:18px;background-color:${AVATAR};` +
    `color:${AVATAR_TEXT};font-family:${FONT};font-size:14px;font-weight:bold;line-height:36px;` +
    `mso-line-height-rule:exactly;text-align:center">${escapeHtml(letters)}</td></tr></table></td>` +
    `<td valign="middle" dir="${emailDir}" style="font-family:${FONT}">` +
    `<div class="email-text" style="font-size:14px;line-height:20px;font-weight:bold;color:${TEXT}">` +
    `${isolated(entry.name, emailDir)}</div>` +
    `<div class="email-muted" style="font-size:12px;line-height:18px;color:${MUTED}">` +
    `<span dir="ltr">${escapeHtml(israelTime(entry.at))}</span></div></td></tr>` +
    `<tr><td colspan="2" dir="${content.dir}" class="email-text email-content" style="padding-top:10px;font-family:${FONT};` +
    `font-size:15px;line-height:22px;color:${TEXT};word-break:break-word;overflow-wrap:anywhere">` +
    `${content.html}</td></tr></table>`
  )
}

export interface Built {
  html: string
  text: string
  /** The images the HTML embeds. */
  images: EntryImage[]
}

/** The email's HTML and text parts for one trim. */
export function layout(conversation: Conversation, trim: Trim): Built {
  const { dir, words, history } = conversation
  const used = new Map<string, EntryImage>()
  const forms = history.map((_, index) => formOf(index, history.length, trim.level))
  const shown = history.filter((_, index) => forms[index] !== "omitted")
  const omitted = history.length - shown.length
  const start = side(dir)

  const reference = `${escapeHtml(words.reference)}: <span dir="ltr">${escapeHtml(conversation.referenceCode)}</span>`
  const meta = `font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED}`
  let rows =
    `<tr><td dir="${dir}" class="email-muted" style="${meta}">${escapeHtml(words.header)}</td></tr>` +
    `<tr><td dir="${dir}" class="email-muted email-line" style="${meta};padding-bottom:12px;` +
    `border-bottom:1px solid ${LINE}">${reference}</td></tr>` +
    `<tr><td style="padding-top:16px">` +
    `${blockHtml(conversation.current, "full", words, dir, COLUMN_WIDTH, false, used)}</td></tr>`
  if (history.length) {
    const newest = history[0] as Entry
    const attribution = escapeHtml(words.attribution)
      .replace("{date}", `<span dir="ltr">${escapeHtml(israelTime(newest.at))}</span>`)
      .replace("{name}", isolated(newest.name, dir))
    const blocks = history
      .map((entry, index) => ({ entry, form: forms[index] as Form }))
      .filter(({ form }) => form !== "omitted")
      .map(
        ({ entry, form }, index) =>
          `<div style="${index ? "padding-top:20px" : ""}">` +
          `${blockHtml(entry, form, words, dir, COLUMN_WIDTH - QUOTE_INDENT, trim.imageNames, used)}</div>`,
      )
      .join("")
    const older = omitted
      ? `<div dir="${dir}" class="email-muted" style="padding-top:20px;${meta}">` +
        `${escapeHtml(fill(words.olderOmitted, { count: String(omitted) }))}</div>`
      : ""
    rows +=
      `<tr><td dir="${dir}" style="padding-top:28px;font-family:${FONT}">` +
      `<div dir="${dir}" class="email-muted" style="${meta}">${attribution}</div>` +
      `<blockquote type="cite" dir="${dir}" class="email-line" style="margin:10px 0 0 0;padding:0;` +
      `padding-${start}:12px;border-${start}:2px solid ${LINE}">${blocks}${older}</blockquote></td></tr>`
  }
  const html =
    `<!doctype html><html dir="${dir}" lang="${conversation.lang}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">` +
    `<style>${STYLE}</style></head>` +
    `<body dir="${dir}" class="email-body" style="margin:0;padding:0;background-color:#FFFFFF">` +
    `<table role="presentation" dir="${dir}" class="email-bg" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `bgcolor="#FFFFFF" style="width:100%;background-color:#FFFFFF"><tr><td align="center" style="padding:16px 12px">` +
    `<table role="presentation" dir="${dir}" width="${COLUMN_WIDTH}" cellpadding="0" cellspacing="0" border="0" ` +
    `style="width:100%;max-width:${COLUMN_WIDTH}px">${rows}</table></td></tr></table></body></html>`

  return { html, text: textPart(conversation, forms, omitted), images: [...used.values()] }
}

/** The text part: the same order, the history quoted with "> ". */
function textPart(conversation: Conversation, forms: readonly Form[], omitted: number): string {
  const { words, history } = conversation
  // The code isolated left to right, as in the HTML.
  const lines = [words.header, `${words.reference}: ${LRI}${conversation.referenceCode}${PDI}`, ""]
  const block = (entry: Entry, form: Form) => {
    const body = form === "short" ? shortText(entry) : textOf(entry)
    const out = [`${entry.name} | ${israelTime(entry.at)}`, ...body.replace(/\r\n?/g, "\n").split("\n")]
    if (form === "full" && entry.files.length)
      out.push(fill(words.files, { names: entry.files.map((file) => file.name).join(", ") }))
    return out
  }
  lines.push(...block(conversation.current, "full"))
  if (history.length) {
    const newest = history[0] as Entry
    lines.push("", fill(words.attribution, { date: israelTime(newest.at), name: newest.name }))
    const quoted: string[] = []
    history.forEach((entry, index) => {
      const form = forms[index] as Form
      if (form === "omitted") return
      if (quoted.length) quoted.push("")
      quoted.push(...block(entry, form))
    })
    if (omitted) quoted.push("", fill(words.olderOmitted, { count: String(omitted) }))
    lines.push(...quoted.map((line) => (line === "" ? ">" : `> ${line}`)))
  }
  return `${lines.join("\n")}\n`
}
