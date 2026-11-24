import sharp from "sharp"
import { COLUMN_WIDTH, type ImageType, type PreparedImage } from "./sizes.ts"

export { COLUMN_WIDTH, type ImageType, type PreparedImage, shownSize } from "./sizes.ts"

export const IMAGE_MAX_WIDTH = COLUMN_WIDTH * 2

const INPUT_PIXELS_MAX = 50_000_000

const FORMATS = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const satisfies Record<ImageType, string>

export const EMBEDDABLE_TYPES = Object.keys(FORMATS) as ImageType[]

export async function prepareImage(bytes: Buffer, contentType: string): Promise<PreparedImage | null> {
  if (!(contentType in FORMATS)) return null
  const type = contentType as ImageType
  try {
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

export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
export const MESSAGE_IMAGES_MAX_BYTES = 20 * 1024 * 1024

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
