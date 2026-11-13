// The images a customer's email embeds (requirements 4.2 and 4.3, plan 3.2), read and downscaled with sharp through
// its documented API: metadata() for the size as shown (autoOrient, so a photo turned by its EXIF orientation has the
// width and height it is seen at), and autoOrient, resize, and the image's own output format for an image wider than
// the email needs. The email shows an image at most the column wide; the bytes keep twice that, for sharp screens.
// An animated image (more than one page) is sent as it is, only sized. An image sharp cannot read is not embedded.

import sharp from "sharp"

/** The width of the email's column in CSS pixels (the layout's inner table). */
export const COLUMN_WIDTH = 600

/** The widest an embedded image is kept, in pixels: twice the column. */
export const IMAGE_MAX_WIDTH = COLUMN_WIDTH * 2

/** The most pixels sharp reads from one image (a guard against decompression bombs): 50 megapixels. */
const INPUT_PIXELS_MAX = 50_000_000

const FORMATS = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as const

export type ImageType = keyof typeof FORMATS

export const EMBEDDABLE_TYPES = Object.keys(FORMATS) as ImageType[]

export interface PreparedImage {
  content: Buffer
  contentType: ImageType
  /** The size the image is seen at, in pixels, after any downscaling. */
  width: number
  height: number
}

/** An image ready to embed: downscaled when wider than IMAGE_MAX_WIDTH; null when sharp cannot read it. */
export async function prepareImage(bytes: Buffer, contentType: string): Promise<PreparedImage | null> {
  if (!(contentType in FORMATS)) return null
  const type = contentType as ImageType
  try {
    // failOn "warning": the input is untrusted, as sharp recommends for it.
    const options = { limitInputPixels: INPUT_PIXELS_MAX, failOn: "warning" } as const
    const meta = await sharp(bytes, options).metadata()
    const { width, height } = meta.autoOrient
    if (!width || !height) return null
    if (width <= IMAGE_MAX_WIDTH || (meta.pages ?? 1) > 1) return { content: bytes, contentType: type, width, height }
    const { data, info } = await sharp(bytes, options)
      .autoOrient()
      .resize({ width: IMAGE_MAX_WIDTH, withoutEnlargement: true })
      .toFormat(FORMATS[type], type === "image/jpeg" ? { quality: 82 } : {})
      .toBuffer({ resolveWithObject: true })
    return { content: data, contentType: type, width: info.width, height: info.height }
  } catch {
    return null
  }
}

/** The size an image is shown at in a column: no wider than the column, the height in proportion. */
export function shownSize(image: { width: number; height: number }, column: number): { width: number; height: number } {
  const width = Math.min(image.width, column)
  return { width, height: Math.max(1, Math.round((image.height * width) / image.width)) }
}

/** The most one history image and one history message may embed (as the ticket view's frame shows them). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const MESSAGE_IMAGES_MAX_BYTES = 20 * 1024 * 1024

/**
 * Which history images are read and embedded, decided from their stored sizes before any byte is read: newest first,
 * each within IMAGE_MAX_BYTES, its message within MESSAGE_IMAGES_MAX_BYTES, and all of them within `budget`. The rest
 * are shown by their names. `candidates` are in the history's order (newest message first); true means read it.
 */
export function imagesToRead(candidates: readonly { message: number; size: number }[], budget: number): boolean[] {
  let total = 0
  const perMessage = new Map<number, number>()
  return candidates.map(({ message, size }) => {
    const own = perMessage.get(message) ?? 0
    if (size > IMAGE_MAX_BYTES || own + size > MESSAGE_IMAGES_MAX_BYTES || total + size > budget) return false
    total += size
    perMessage.set(message, own + size)
    return true
  })
}
