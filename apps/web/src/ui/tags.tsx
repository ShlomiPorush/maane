export type Tone = "ok" | "warn" | "fail" | "info" | "neutral"

export function Tag({ tone, children }: { tone: Tone; children: string }) {
  return <span className={tone === "neutral" ? "ui-tag" : `ui-tag ui-tag-${tone}`}>{children}</span>
}
