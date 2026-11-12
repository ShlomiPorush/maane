import { fileTypeFromBuffer } from "file-type"

// The type of a file, decided from its content and never from its name or the type the sender declared (plan 2.2,
// P9; requirements 3.2). Binary formats come from file-type. Text is decided by a strict rule, so that a preview can
// never be fooled into rendering markup: a text preview is always served as text/plain.

/** Content the text rule accepts. */
export const TEXT_TYPE = "text/plain"
/** Anything else: an unknown format, binary data, and markup (SVG, HTML, XML that file-type does not name). */
export const UNKNOWN_TYPE = "application/octet-stream"

export interface DetectedType {
  /** The MIME type file-type reports, TEXT_TYPE, or UNKNOWN_TYPE. */
  mime: string
  /** file-type's extension for its MIME type, or null for text and unknown content. */
  ext: string | null
}

export async function detectType(bytes: Uint8Array): Promise<DetectedType> {
  const found = await fileTypeFromBuffer(bytes)
  if (found) return { mime: found.mime, ext: found.ext }
  return { mime: isPlainText(bytes) ? TEXT_TYPE : UNKNOWN_TYPE, ext: null }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
/** Every control character (Unicode Cc, NUL among them) except tab, line feed, form feed, and carriage return. */
const FORBIDDEN_CONTROL = /[^\P{Cc}\t\n\f\r]/u
const BYTE_ORDER_MARK = 0xfeff

/**
 * Text, by the rule of the plan: valid UTF-8, no control character but tab, line feed, carriage return, and form
 * feed, and not markup: after an optional byte order mark and white space, it does not start with `<`. Call it only
 * when file-type found no format.
 */
export function isPlainText(bytes: Uint8Array): boolean {
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    return false
  }
  if (FORBIDDEN_CONTROL.test(text)) return false
  const body = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text
  return !body.trimStart().startsWith("<")
}
