import { convert } from "html-to-text"
import { textDirection } from "../mail/bidi.ts"
import { type Direction, directBlocks, messageDirection } from "../mail/direction.ts"
import { renderEmailHtml } from "../mail/html.ts"
import { COLUMN_WIDTH, type PreparedImage, shownSize } from "./sizes.ts"
import { wordCopies } from "./word.ts"

export interface MailWords {
  header: string
  reference: string
  attribution: string
  files: string
  olderOmitted: string
}

export type EntryImage = PreparedImage & { cid: string; fileName: string }

export interface Entry {
  name: string
  initialsOf: string
  at: Date
  html: string | null
  text: string | null
  images: Map<string, EntryImage>
  imageNames?: Map<string, string>
  files: readonly EntryFile[]
  link?: (href: string) => string
}

export interface EntryFile {
  name: string
  href: string | null
}

export interface Conversation {
  dir: Direction
  lang: string
  words: MailWords
  referenceCode: string
  current: Entry
  history: readonly Entry[]
}

export interface Trim {
  level: number
  imageNames: boolean
}

export type Form = "full" | "short" | "omitted"

export function formOf(index: number, count: number, level: number): Form {
  const fromOldest = count - 1 - index
  if (fromOldest < level - count) return "omitted"
  if (fromOldest < level) return "short"
  return "full"
}

export const LRI = String.fromCodePoint(0x2066)
export const PDI = String.fromCodePoint(0x2069)

export const SHORT_CHARACTERS = 280

const TEXT = "#222222"
const MUTED = "#666666"
const LINE = "#E0E0E0"
const AVATAR = "#EEEEEE"
const AVATAR_TEXT = "#333333"
const FONT = "Arial,Helvetica,sans-serif"
const QUOTE_INDENT = 14

const STYLE = [
  ":root{color-scheme:light dark;supported-color-schemes:light dark}",
  ".email-bg a{color:inherit !important;text-decoration:none !important}",
  ".email-content table{width:auto !important;max-width:100% !important}",
  ".email-content img{max-width:100% !important;height:auto !important}",
  "@media (prefers-color-scheme:dark){",
  ".email-body,.email-bg{background-color:#141414 !important}",
  ".email-text{color:#EEEEEE !important}",
  ".email-muted{color:#AAAAAA !important}",
  ".email-line{border-color:#333333 !important}",
  ".email-avatar{background-color:#333333 !important;color:#EEEEEE !important}",
  ".email-content *{color:inherit !important;background-color:transparent !important;border-color:#333333 !important}",
  "}",
  "[data-ogsb] .email-bg{background-color:#FFFFFF !important}",
  "[data-ogsb] .email-avatar{background-color:#333333 !important}",
  "[data-ogsb] .email-line{border-color:#333333 !important}",
].join("")

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)

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

export function israelTime(date: Date): string {
  const parts = ISRAEL.formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ""
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`
}

export function initials(name: string): string {
  const letters = name
    .split(/[\s@._-]+/)
    .map((word) => [...word].find((char) => /\p{L}/u.test(char)))
    .filter((letter): letter is string => letter !== undefined)
  const chosen = letters.length > 1 ? [letters[0], letters.at(-1)] : letters.slice(0, 1)
  return chosen.join("").toLocaleUpperCase("en") || "?"
}

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

export function shortText(entry: Entry): string {
  const flat = textOf(entry).replace(/\s+/g, " ").trim()
  const chars = [...flat]
  return chars.length > SHORT_CHARACTERS ? `${chars.slice(0, SHORT_CHARACTERS).join("").trimEnd()}...` : flat
}

const side = (dir: Direction) => (dir === "rtl" ? "right" : "left")
const otherSide = (dir: Direction) => (dir === "rtl" ? "left" : "right")
const isolated = (text: string, around: Direction) =>
  `<span dir="${textDirection(text) ?? around}">${escapeHtml(text)}</span>`

function linesHtml(text: string, dir: Direction): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `<div dir="${textDirection(line) ?? dir}">${line.trim() === "" ? "<br>" : escapeHtml(line)}</div>`)
    .join("")
}

type Content = { html: string; dir: Direction; images: EntryImage[] }

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
  const dir = messageDirection(entry.text, entry.html, around)
  if (form === "short") {
    const text = shortText(entry)
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
  return { html: wordCopies(html), dir, images }
}

const fileLine = (filesWord: string, files: readonly EntryFile[], dir: Direction) => {
  const [before = "", after = ""] = filesWord.split("{names}")
  const names = files.map((file) =>
    file.href
      ? `<a href="${escapeHtml(file.href)}" style="text-decoration:underline !important">${isolated(file.name, dir)}</a>`
      : isolated(file.name, dir),
  )
  return `${escapeHtml(before)}${names.join(", ")}${escapeHtml(after)}`
}

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
  images: EntryImage[]
}

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
    const attribution = fill(escapeHtml(words.attribution), {
      date: `<span dir="ltr">${escapeHtml(israelTime(newest.at))}</span>`,
      name: isolated(newest.name, dir),
    })
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

function textPart(conversation: Conversation, forms: readonly Form[], omitted: number): string {
  const { words, history } = conversation
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
