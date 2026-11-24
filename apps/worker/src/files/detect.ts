import { fileTypeFromBuffer } from "file-type"

export const TEXT_TYPE = "text/plain"
export const UNKNOWN_TYPE = "application/octet-stream"

export interface DetectedType {
  mime: string
  ext: string | null
}

export async function detectType(bytes: Uint8Array): Promise<DetectedType> {
  const found = await fileTypeFromBuffer(bytes)
  if (found) return { mime: found.mime, ext: found.ext }
  return { mime: isPlainText(bytes) ? TEXT_TYPE : UNKNOWN_TYPE, ext: null }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
const FORBIDDEN_CONTROL = /[^\P{Cc}\t\n\f\r]/u
const BYTE_ORDER_MARK = 0xfeff

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
