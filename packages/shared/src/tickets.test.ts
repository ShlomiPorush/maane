import { describe, expect, it } from "vitest"
import { PART_STATUSES } from "./intake.ts"
import { previewKind } from "./tickets.ts"

describe("previewKind", () => {
  it("previews images, PDF, and text by the detected type, only when clean", () => {
    expect(previewKind("clean", "image/png")).toBe("image")
    expect(previewKind("clean", "image/jpeg")).toBe("image")
    expect(previewKind("clean", "image/gif")).toBe("image")
    expect(previewKind("clean", "image/webp")).toBe("image")
    expect(previewKind("clean", "application/pdf")).toBe("pdf")
    expect(previewKind("clean", "text/plain")).toBe("text")
    for (const status of PART_STATUSES.filter((status) => status !== "clean"))
      expect(previewKind(status, "image/png"), status).toBeNull()
  })

  it("never previews SVG, markup, Office files, or anything else", () => {
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/xml",
      "application/octet-stream",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/x-cfb",
      "image/bmp",
      "toString",
      "__proto__",
    ])
      expect(previewKind("clean", type), type).toBeNull()
    expect(previewKind("clean", null)).toBeNull()
  })
})
