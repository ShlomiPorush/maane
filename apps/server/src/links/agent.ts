/// <reference path="./uap-ref-impl.d.ts" />
// The user agent of a click (plan 3.4): browser, operating system, and kind of device, by the standard uap-core rules
// (the ua-parser organisation's `regexes.yaml`) through its own reference implementation, `uap-ref-impl`. uap-core
// names a browser, an OS, and a device family, but no kind of device: the kind is read from those (`deviceType`).

import { readFileSync } from "node:fs"
// Named apart from createRequire: the server bundle's banner declares that name already (package.json, build).
import { createRequire as requireFrom } from "node:module"
import { CLICK_BOUNDS, type DeviceType } from "@maane/shared"
import uapParser from "uap-ref-impl"
import { parse as parseYaml } from "yaml"
import { bounded } from "./bounds.ts"

/**
 * Clients uap-core names that are programs, not people: a headless browser and HTTP libraries (families from
 * uap-core's `user_agent_parsers`). With uap-core's own `Spider` device family they make a click `bot`.
 */
export const AUTOMATION_FAMILIES: ReadonlySet<string> = new Set([
  "HeadlessChrome",
  "python-requests",
  "Python-urllib",
  "curl",
  "Wget",
  "Go-http-client",
  "Apache-HttpClient",
  "okhttp",
  "axios",
])

/** Operating systems of phones and tablets, as uap-core names them. */
const MOBILE_OS: ReadonlySet<string> = new Set(["iOS", "Android", "Windows Phone", "BlackBerry OS", "KaiOS", "iPadOS"])

let parser: ReturnType<typeof uapParser> | undefined

/** The parser, built once from the rules uap-core ships (read from its package, which the image's node_modules holds). */
function uap() {
  if (!parser) {
    const file = requireFrom(import.meta.url).resolve("uap-core/regexes.yaml")
    parser = uapParser(parseYaml(readFileSync(file, "utf8")))
  }
  return parser
}

export interface Agent {
  device: DeviceType | null
  os: string | null
  browser: string | null
  userAgent: string | null
}

const named = (family: string, major: string | null, max: number) =>
  family === "Other" ? null : bounded(major ? `${family} ${major}` : family, max)

/** The kind of device: a known crawler or program, a tablet, a phone, a computer, or other. */
export function deviceType(userAgent: string, browser: string, os: string, device: string): DeviceType {
  if (device === "Spider" || AUTOMATION_FAMILIES.has(browser)) return "bot"
  if (device === "iPad" || (os === "Android" && !/\bMobile\b/.test(userAgent))) return "tablet"
  if (MOBILE_OS.has(os) || device === "iPhone") return "mobile"
  if (os !== "Other") return "desktop"
  return "other"
}

/** What a click's user agent says, every string bounded; nothing for no user agent. */
export function parseAgent(header: string | null | undefined): Agent {
  const userAgent = header ? bounded(header, CLICK_BOUNDS.userAgent) : null
  if (!userAgent) return { device: null, os: null, browser: null, userAgent: null }
  const result = uap().parse(userAgent)
  return {
    device: deviceType(userAgent, result.ua.family, result.os.family, result.device.family),
    os: named(result.os.family, result.os.major, CLICK_BOUNDS.os),
    browser: named(result.ua.family, result.ua.major, CLICK_BOUNDS.browser),
    userAgent,
  }
}
