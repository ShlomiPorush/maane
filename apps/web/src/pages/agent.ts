// A signed-in browser in words, from its User-Agent: "Firefox on Android". Names of browsers and systems are
// product names, the same in every language. Null when it says nothing recognisable.

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Headless)?(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
]

const SYSTEMS: [RegExp, string][] = [
  [/\bAndroid\b/, "Android"],
  [/\b(?:iPhone|iPad|iPod)\b/, "iOS"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
]

export function describeAgent(userAgent: string | null): { browser: string; system: string } | null {
  if (!userAgent) return null
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1]
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1]
  if (!browser || !system) return null
  return { browser, system }
}
