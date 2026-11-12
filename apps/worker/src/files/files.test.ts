import { createHash } from "node:crypto"
import { SCANNER_CHECKS } from "@maane/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MARKERS, refusedAddress, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { detectType, isPlainText, TEXT_TYPE, UNKNOWN_TYPE } from "./detect.ts"
import { CLEAN_SAMPLE, ENCRYPTED_PDF, ENCRYPTED_ZIP, eicar } from "./samples.ts"
import { clamdScanner, verdictOf } from "./scanner.ts"
import { runSelfTest, SAMPLE_CHECKS } from "./self-test.ts"
import { blockedBy } from "./service.ts"

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const utf8 = (text: string) => Buffer.from(text, "utf8")
/** Hebrew text from code points: no file but he.json holds literal Hebrew. */
const hebrew = String.fromCodePoint(0x5e9, 0x5dc, 0x5d5, 0x5dd)

describe("self-test samples", () => {
  it("EICAR is the 68-byte standard test file, built at run time", () => {
    const file = eicar()
    expect(file.length).toBe(68)
    // The published SHA-256 of the 68-byte EICAR test file.
    expect(sha256(file)).toBe("275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f")
  })

  it("the encrypted samples decode to the files they were made from", () => {
    expect(sha256(ENCRYPTED_ZIP)).toBe("2a360fdd79ce4bb2ca80b0efc23972e178c1e4ae208962e45da5b6c82b2a5210")
    expect(sha256(ENCRYPTED_PDF)).toBe("cccdd1045e9deba5f9eb1e3f9299741d5ed5adb67b7750619f8b3013334481a6")
  })

  it("the sample checks follow SCANNER_CHECKS after the connection", () => {
    expect(["connection", ...SAMPLE_CHECKS.map((entry) => entry.check)]).toEqual([...SCANNER_CHECKS])
  })
})

describe("verdicts", () => {
  it("is clean only when clamscan says isInfected false", () => {
    expect(verdictOf({ isInfected: false, viruses: [] })).toEqual({ kind: "clean" })
    expect(verdictOf({ isInfected: null, viruses: [] })).toEqual({ kind: "error" })
    expect(verdictOf({ isInfected: true, viruses: [] })).toEqual({ kind: "error" })
    expect(verdictOf({ isInfected: true, viruses: [" "] })).toEqual({ kind: "error" })
    expect(verdictOf({ isInfected: true })).toEqual({ kind: "error" })
  })

  it("names an infection, and an encrypted or limits alert as not fully scanned", () => {
    expect(verdictOf({ isInfected: true, viruses: ["Eicar-Test-Signature"] })).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    })
    for (const alert of [
      "Heuristics.Encrypted.Zip",
      "Heuristics.Encrypted.PDF",
      "Heuristics.Limits.Exceeded.MaxFileSize",
      "Heuristics.Limits.Exceeded.MaxRecursion",
    ])
      expect(verdictOf({ isInfected: true, viruses: [alert] })).toEqual({ kind: "not_fully_scanned", signature: alert })
    // Another heuristic is a detection, not a limit.
    expect(verdictOf({ isInfected: true, viruses: ["Heuristics.Phishing.Email.SpoofedDomain"] }).kind).toBe("infected")
    // A signature wins over an alert.
    expect(verdictOf({ isInfected: true, viruses: ["Heuristics.Encrypted.Zip", "Win.Test.EICAR_HDB-1"] })).toEqual({
      kind: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    })
  })
})

describe("the clamd client against the stand-in", () => {
  let clamd: StandInClamd
  beforeAll(async () => {
    clamd = await startStandInClamd()
  })
  afterAll(async () => {
    await clamd.close()
  })

  it("streams the content and reads each answer", async () => {
    expect(await clamdScanner.scan(clamd.address, eicar())).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    })
    expect(await clamdScanner.scan(clamd.address, ENCRYPTED_ZIP)).toEqual({
      kind: "not_fully_scanned",
      signature: "Heuristics.Encrypted.Zip",
    })
    expect(await clamdScanner.scan(clamd.address, utf8(`x ${MARKERS.limits}`))).toEqual({
      kind: "not_fully_scanned",
      signature: "Heuristics.Limits.Exceeded.MaxFileSize",
    })
    expect(await clamdScanner.scan(clamd.address, CLEAN_SAMPLE)).toEqual({ kind: "clean" })
    expect(await clamdScanner.scan(clamd.address, new Uint8Array(0))).toEqual({ kind: "clean" })
    // Three chunks of 64 KiB and a remainder arrive as one stream.
    const large = Buffer.alloc(200_000, 0x61)
    expect(await clamdScanner.scan(clamd.address, large)).toEqual({ kind: "clean" })
    expect(clamd.scanned.at(-1)?.equals(large)).toBe(true)
  })

  it("gives no verdict for an error reply, a refused connection, or a stall that hits the timeout", async () => {
    expect(await clamdScanner.scan(clamd.address, utf8(MARKERS.error))).toEqual({ kind: "error" })
    expect(await clamdScanner.scan(await refusedAddress(), CLEAN_SAMPLE)).toEqual({ kind: "error" })
    const started = Date.now()
    expect(await clamdScanner.scan(clamd.address, utf8(MARKERS.stall), 500)).toEqual({ kind: "error" })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("pings and reads the version", async () => {
    expect(await clamdScanner.ping(clamd.address)).toBe(true)
    expect(await clamdScanner.version(clamd.address)).toBe("ClamAV 1.5.4/0/stand-in")
    expect(await clamdScanner.ping(await refusedAddress())).toBe(false)
  })
})

describe("the self-test", () => {
  const at = new Date("2026-11-12T10:00:00Z")
  const run = async (options: Parameters<typeof startStandInClamd>[0]) => {
    const clamd = await startStandInClamd(options)
    try {
      return await runSelfTest(clamdScanner, clamd.address, () => at)
    } finally {
      await clamd.close()
    }
  }

  it("passes a scanner that gives every alert", async () => {
    const result = await run({})
    expect(result).toMatchObject({ ok: true, failedCheck: null, version: "ClamAV 1.5.4/0/stand-in", checkedAt: at })
  })

  it("names the check a scanner fails", async () => {
    expect((await run({ noSignatures: true })).failedCheck).toBe("eicar")
    expect((await run({ noEncryptedAlerts: true })).failedCheck).toBe("encrypted_zip")
    expect((await run({ alertsOnEverything: true })).failedCheck).toBe("encrypted_zip")
    const refused = await runSelfTest(clamdScanner, await refusedAddress(), () => at)
    expect(refused).toMatchObject({ ok: false, failedCheck: "connection", version: null })
  })
})

describe("detected types", () => {
  it("reads binary formats from the content, whatever the name says", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
    expect((await detectType(png)).mime).toBe("image/png")
    expect((await detectType(ENCRYPTED_PDF)).mime).toBe("application/pdf")
    expect((await detectType(ENCRYPTED_ZIP)).mime).toBe("application/zip")
    expect(await detectType(utf8('<?xml version="1.0"?><svg/>'))).toEqual({ mime: "application/xml", ext: "xml" })
  })

  it("calls content text only by the text rule", async () => {
    expect((await detectType(utf8(`Hello\t${hebrew}\r\n\fend`))).mime).toBe(TEXT_TYPE)
    expect(isPlainText(utf8(""))).toBe(true)
    expect(isPlainText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe(true)
    // NUL, another control character, invalid UTF-8, and a C1 control character are not text.
    expect(isPlainText(Buffer.from([0x61, 0x00, 0x62]))).toBe(false)
    expect(isPlainText(Buffer.from([0x61, 0x01, 0x62]))).toBe(false)
    expect(isPlainText(Buffer.from([0x61, 0xff, 0x62]))).toBe(false)
    expect(isPlainText(utf8(`a${String.fromCodePoint(0x85)}b`))).toBe(false)
    expect((await detectType(Buffer.from([0x61, 0x00, 0x62]))).mime).toBe(UNKNOWN_TYPE)
  })

  it("never calls markup text, also after a byte order mark and white space", async () => {
    for (const markup of ["<svg xmlns='http://www.w3.org/2000/svg'/>", "  \n<html></html>", "<script>x</script>"])
      expect((await detectType(utf8(markup))).mime).toBe(UNKNOWN_TYPE)
    expect(isPlainText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8(" \t<svg/>")]))).toBe(false)
    expect(isPlainText(utf8("a < b"))).toBe(true)
  })
})

describe("blocked types", () => {
  const list = ["exe", "js", "application/x-msdownload"]
  const text = { mime: TEXT_TYPE, ext: null }

  it("blocks by the name's extension, ignoring case and trailing dots and spaces", () => {
    expect(blockedBy(list, "invoice.EXE", text)).toBe("exe")
    expect(blockedBy(list, "invoice.pdf.js. ", text)).toBe("js")
    expect(blockedBy(list, "invoice.pdf", text)).toBeNull()
    expect(blockedBy(list, null, text)).toBeNull()
    expect(blockedBy(list, "exe", text)).toBeNull()
  })

  it("blocks by the detected type and its extension, so a renamed program is blocked", () => {
    expect(blockedBy(list, "photo.jpg", { mime: "application/x-msdownload", ext: "exe" })).toBe(
      "application/x-msdownload",
    )
    expect(blockedBy(["exe"], "photo.jpg", { mime: "application/x-msdownload", ext: "exe" })).toBe("exe")
  })
})
