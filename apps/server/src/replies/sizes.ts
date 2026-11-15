// The sizes the customer's email lays images out at (plan 3.2), kept apart from images.ts, which reads images with
// sharp: the layout (layout.ts) and the builder (mail.ts) need only these, so the worker can build an email that embeds
// no history image (a reminder, plan 4.3) without loading sharp.

/** The width of the email's column in CSS pixels (the layout's inner table). */
export const COLUMN_WIDTH = 600

/** The image types an email embeds. */
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const

export type ImageType = (typeof IMAGE_TYPES)[number]

export interface PreparedImage {
  content: Buffer
  contentType: ImageType
  /** The size the image is seen at, in pixels, after any downscaling. */
  width: number
  height: number
}

/** The size an image is shown at in a column: no wider than the column, the height in proportion. */
export function shownSize(image: { width: number; height: number }, column: number): { width: number; height: number } {
  const width = Math.min(image.width, column)
  return { width, height: Math.max(1, Math.round((image.height * width) / image.width)) }
}
