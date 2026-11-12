import { describe, expect, it } from "vitest"
import {
  BLOCKED_TYPE,
  DEFAULT_BLOCKED_TYPES,
  FILES_MAX_BYTES_MAX,
  normalizeBlockedTypes,
  parseScannerAddress,
  SETTINGS,
} from "./settings.ts"

describe("scanner address", () => {
  it("reads a host name, an IPv4 address, or a bracketed IPv6 address with a port", () => {
    expect(parseScannerAddress("clamav:3310")).toEqual({ host: "clamav", port: 3310 })
    expect(parseScannerAddress("scanner.example.com:3310")).toEqual({ host: "scanner.example.com", port: 3310 })
    expect(parseScannerAddress("192.0.2.10:3310")).toEqual({ host: "192.0.2.10", port: 3310 })
    expect(parseScannerAddress("[2001:db8::10]:3310")).toEqual({ host: "2001:db8::10", port: 3310 })
  })

  it("refuses anything else", () => {
    for (const text of ["clamav", "clamav:", ":3310", "clamav:0", "clamav:65536", "tcp://clamav:3310", "a b:1", "-x:1"])
      expect(parseScannerAddress(text), text).toBeNull()
    expect(SETTINGS["scanner.address"].schema.safeParse("clamav:3310").success).toBe(true)
    expect(SETTINGS["scanner.address"].schema.safeParse("clamav").success).toBe(false)
  })
})

describe("blocked types", () => {
  it("writes a list in lower case, without dots, each entry once", () => {
    expect(normalizeBlockedTypes(" .EXE, js\nexe  Application/X-MSDownload ,, ")).toEqual([
      "exe",
      "js",
      "application/x-msdownload",
    ])
  })

  it("has a default list the setting accepts", () => {
    expect(DEFAULT_BLOCKED_TYPES.every((entry) => BLOCKED_TYPE.test(entry))).toBe(true)
    expect(SETTINGS["files.blockedTypes"].schema.safeParse([...DEFAULT_BLOCKED_TYPES]).success).toBe(true)
    expect(SETTINGS["files.blockedTypes"].schema.safeParse(["EXE"]).success).toBe(false)
    expect(SETTINGS["files.blockedTypes"].schema.safeParse([".exe"]).success).toBe(false)
  })

  it("keeps the size limit within what the bundled clamd streams (StreamMaxLength 100M)", () => {
    expect(FILES_MAX_BYTES_MAX).toBe(100 * 1024 * 1024)
    expect(SETTINGS["files.maxBytes"].schema.safeParse(FILES_MAX_BYTES_MAX + 1).success).toBe(false)
  })
})
