export const COLUMN_WIDTH = 600

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const

export type ImageType = (typeof IMAGE_TYPES)[number]

export interface PreparedImage {
  content: Buffer
  contentType: ImageType
  width: number
  height: number
}

export function shownSize(image: { width: number; height: number }, column: number): { width: number; height: number } {
  const width = Math.min(image.width, column)
  return { width, height: Math.max(1, Math.round((image.height * width) / image.width)) }
}
