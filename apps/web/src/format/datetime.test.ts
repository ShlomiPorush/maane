import { describe, expect, it } from "vitest"
import { nextWholeHour, zonedInput, zonedInstant } from "./datetime.ts"

const at = (date: string, time: string) => zonedInstant({ date, time })?.toISOString() ?? null

describe("a time entered in Israel", () => {
  it("is winter time (UTC+2) and summer time (UTC+3) on each side of a change", () => {
    expect(at("2026-01-15", "09:00")).toBe("2026-01-15T07:00:00.000Z")
    expect(at("2026-07-15", "09:00")).toBe("2026-07-15T06:00:00.000Z")
    expect(at("2026-03-27", "01:30")).toBe("2026-03-26T23:30:00.000Z")
    expect(at("2026-03-27", "03:30")).toBe("2026-03-27T00:30:00.000Z")
    expect(at("2026-10-25", "02:30")).toBe("2026-10-25T00:30:00.000Z")
  })

  it("does not exist in the hour the clock skips in spring", () => {
    expect(at("2026-03-27", "02:00")).toBeNull()
    expect(at("2026-03-27", "02:59")).toBeNull()
  })

  it("is the first of the two in the hour that repeats in autumn", () => {
    expect(at("2026-10-25", "01:30")).toBe("2026-10-24T22:30:00.000Z")
  })

  it("is refused when it is not a real date and time", () => {
    expect(at("2026-02-31", "09:00")).toBeNull()
    expect(at("2026-11-15", "24:00")).toBeNull()
    expect(at("", "09:00")).toBeNull()
    expect(at("2026-11-15", "9:00")).toBeNull()
  })

  it("reads back as the same date and time", () => {
    for (const iso of ["2026-03-26T23:30:00.000Z", "2026-10-24T22:30:00.000Z", "2026-10-24T23:30:00.000Z"]) {
      const input = zonedInput(new Date(iso))
      expect(zonedInput(zonedInstant(input) ?? new Date(0))).toEqual(input)
    }
    expect(zonedInput(new Date("2026-10-24T23:30:00.000Z"))).toEqual({ date: "2026-10-25", time: "01:30" })
  })

  it("starts from the next whole hour at least an hour ahead", () => {
    expect(nextWholeHour(new Date("2026-11-15T08:20:00.000Z"))).toEqual({ date: "2026-11-15", time: "12:00" })
    expect(nextWholeHour(new Date("2026-11-15T21:00:00.000Z"))).toEqual({ date: "2026-11-16", time: "00:00" })
  })
})
