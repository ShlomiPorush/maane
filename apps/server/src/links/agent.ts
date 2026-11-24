/// <reference path="./uap-ref-impl.d.ts" />

import { readFileSync } from "node:fs"
import { createRequire as requireFrom } from "node:module"
import { CLICK_BOUNDS, type DeviceType } from "@maane/shared"
import uapParser from "uap-ref-impl"
import { parse as parseYaml } from "yaml"
import { bounded } from "./bounds.ts"

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

const MOBILE_OS: ReadonlySet<string> = new Set(["iOS", "Android", "Windows Phone", "BlackBerry OS", "KaiOS", "iPadOS"])

let parser: ReturnType<typeof uapParser> | undefined

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

export function deviceType(userAgent: string, browser: string, os: string, device: string): DeviceType {
  if (device === "Spider" || AUTOMATION_FAMILIES.has(browser)) return "bot"
  if (device === "iPad" || (os === "Android" && !/\bMobile\b/.test(userAgent))) return "tablet"
  if (MOBILE_OS.has(os) || device === "iPhone") return "mobile"
  if (os !== "Other") return "desktop"
  return "other"
}

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
