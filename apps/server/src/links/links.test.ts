import { copyFile, mkdtemp, rm, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLICK_BOUNDS } from "@maane/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseAgent } from "./agent.ts"
import { bounded } from "./bounds.ts"
import { ASN_FILE, CITY_FILE, Geo, NO_LOCATION } from "./geo.ts"
import { scannerReasons } from "./scanner.ts"
import { CODE, linkBase, ReplyLinks } from "./service.ts"

// The GeoLite2 test databases hold only documentation networks (testing/geoip/write-test-databases.go).
const GEOIP = fileURLToPath(new URL("../testing/geoip/", import.meta.url))

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36"
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const IPAD =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
const BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
const HEADLESS =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.6778.86 Safari/537.36"

describe("the links of a reply", () => {
  it("gives each distinct http or https link one random code, and leaves every other link as written", () => {
    const links = new ReplyLinks("https://links.example.com", true)
    const first = links.url("https://www.example.com/a?b=1")
    expect(first).toMatch(/^https:\/\/links\.example\.com\/l\/[A-Za-z0-9_-]{22}$/)
    expect(links.url("https://www.example.com/a?b=1")).toBe(first)
    expect(links.url("http://example.com/x")).not.toBe(first)
    for (const href of ["mailto:help@example.com", "tel:+15550100", "ftp://example.com/x", "not a url", "javascript:x"])
      expect(links.url(href)).toBe(href)
    expect(links.url(`https://example.com/${"a".repeat(2100)}`)).toMatch(/^https:\/\/example\.com\//)
    expect(links.rows.map((row) => row.kind)).toEqual(["url", "url"])
    expect(links.rows.every((row) => CODE.test(row.code))).toBe(true)
    expect(new Set(links.rows.map((row) => row.code)).size).toBe(2)
  })

  it("keeps links as written while tracking is off, and still gives history files their download links", () => {
    const links = new ReplyLinks("https://maane.example.com", false)
    expect(links.url("https://www.example.com/a")).toBe("https://www.example.com/a")
    expect(links.file("6f1c2a52-0d4e-4f55-9a43-2f0e8d1b7c10")).toMatch(
      /^https:\/\/maane\.example\.com\/f\/[A-Za-z0-9_-]{22}$/,
    )
    expect(links.rows).toEqual([
      expect.objectContaining({ kind: "file", partId: "6f1c2a52-0d4e-4f55-9a43-2f0e8d1b7c10" }),
    ])
  })

  it("uses the link domain, or the public URL's own origin when none is set", () => {
    expect(linkBase("links.example.com", new URL("https://maane.example.com/x"))).toBe("https://links.example.com")
    expect(linkBase("", new URL("http://127.0.0.1:8095/"))).toBe("http://127.0.0.1:8095")
  })
})

describe("what a click records", () => {
  it("bounds every string, drops control characters, and keeps strings well formed", () => {
    expect(bounded("a\u0000b\u0007c\u009f d ", 10)).toBe("a�bc d")
    expect(bounded("x".repeat(50), 20)).toHaveLength(20)
    expect(bounded(`${"a".repeat(9)}\u{1f600}`, 10)).toBe(`${"a".repeat(9)}\u{1f600}`)
    expect(bounded("\ud800", 5)).toBe("�")
    expect(bounded("   ", 5)).toBeNull()
    expect(bounded(null, 5)).toBeNull()
  })

  it("reads the browser, the system, and the kind of device by the uap-core rules", () => {
    expect(parseAgent(CHROME_WINDOWS)).toMatchObject({ device: "desktop", os: "Windows 10", browser: "Chrome 131" })
    expect(parseAgent(SAFARI_IPHONE)).toMatchObject({ device: "mobile", os: "iOS 17", browser: "Mobile Safari 17" })
    expect(parseAgent(IPAD)).toMatchObject({ device: "tablet" })
    expect(parseAgent(BINGBOT)).toMatchObject({ device: "bot" })
    expect(parseAgent(HEADLESS)).toMatchObject({ device: "bot", browser: "HeadlessChrome 131" })
    expect(parseAgent(undefined)).toEqual({ device: null, os: null, browser: null, userAgent: null })
  })

  it("keeps the full user agent within its bound", () => {
    const long = `${CHROME_WINDOWS} ${"x".repeat(5000)}`
    const agent = parseAgent(long)
    expect(agent.userAgent).toHaveLength(CLICK_BOUNDS.userAgent)
    expect(agent.browser).toBe("Chrome 131")
    for (const [key, max] of [
      ["os", CLICK_BOUNDS.os],
      ["browser", CLICK_BOUNDS.browser],
    ] as const)
      expect((agent[key] ?? "").length).toBeLessThanOrEqual(max)
  })
})

describe("the location of a click", () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "maane-geo-"))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("reads the country, city, region, ISP, and AS from the local GeoLite2 files", async () => {
    const geo = new Geo(GEOIP)
    expect(await geo.locate("192.0.2.10")).toEqual({
      country: "il",
      city: "Tel Aviv",
      region: "Tel Aviv District",
      isp: "Example Net",
      asn: 64496,
    })
    expect(await geo.locate("2001:db8::1")).toMatchObject({ country: "de", city: "Berlin", asn: 64499 })
    // An address the files do not hold, and something that is not an address.
    expect(await geo.locate("203.0.113.200")).toEqual(NO_LOCATION)
    expect(await geo.locate("not-an-address")).toEqual(NO_LOCATION)
    expect(await geo.locate(null)).toEqual(NO_LOCATION)
  })

  it("bounds every string the files hold", async () => {
    const found = await new Geo(GEOIP).locate("203.0.113.5")
    expect(found.city).toHaveLength(CLICK_BOUNDS.city)
    expect(found.region).toHaveLength(CLICK_BOUNDS.region)
    expect(found.isp).toHaveLength(CLICK_BOUNDS.isp)
    expect(found.country).toBe("xx")
  })

  it("handles each missing file alone, and finds a file that appears later", async () => {
    let now = 0
    const geo = new Geo(dir, () => now)
    expect(await geo.locate("192.0.2.10")).toEqual(NO_LOCATION)
    await copyFile(join(GEOIP, ASN_FILE), join(dir, ASN_FILE))
    // Looked for again only after a minute.
    expect(await geo.locate("192.0.2.10")).toEqual(NO_LOCATION)
    now += 60_000
    expect(await geo.locate("192.0.2.10")).toEqual({ ...NO_LOCATION, isp: "Example Net", asn: 64496 })
    // A damaged City file fails alone: the ASN part stays.
    await copyFile(join(GEOIP, "write-test-databases.go"), join(dir, CITY_FILE))
    now += 60_000
    expect(await geo.locate("192.0.2.10")).toEqual({ ...NO_LOCATION, isp: "Example Net", asn: 64496 })
    // Replaced by a good file: read again by its new modification time.
    await copyFile(join(GEOIP, CITY_FILE), join(dir, CITY_FILE))
    await utimes(join(dir, CITY_FILE), new Date(), new Date(Date.now() + 5_000))
    now += 60_000
    expect(await geo.locate("192.0.2.10")).toMatchObject({ country: "il", asn: 64496 })
  })

  it("gives no location without a directory", async () => {
    expect(await new Geo(null).locate("192.0.2.10")).toEqual(NO_LOCATION)
  })
})

describe("possibly a scanner", () => {
  const sent = new Date("2026-11-13T10:00:00Z")
  const at = (seconds: number) => new Date(sent.getTime() + seconds * 1000)

  it("marks a click within the first minute, a crawler or program, and a scanning provider's network", () => {
    expect(scannerReasons({ at: at(5), asn: null, device: "desktop" }, sent)).toEqual(["early"])
    expect(scannerReasons({ at: at(600), asn: null, device: "desktop" }, sent)).toEqual([])
    expect(scannerReasons({ at: at(600), asn: null, device: "bot" }, sent)).toEqual(["agent"])
    expect(scannerReasons({ at: at(600), asn: 8075, device: "mobile" }, sent)).toEqual(["network"])
    expect(scannerReasons({ at: at(2), asn: 22843, device: "bot" }, sent)).toEqual(["early", "agent", "network"])
    expect(scannerReasons({ at: at(600), asn: 64496, device: null }, sent)).toEqual([])
  })

  it("does not call a click early when the reply has no sending time", () => {
    expect(scannerReasons({ at: at(1), asn: null, device: "desktop" }, null)).toEqual([])
  })
})
