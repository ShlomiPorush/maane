// One tone table (v3 FB-14): the word is the status, colour only reinforces it. A disabled account is a failure,
// two-factor still off is a warning; a role is not a status, so its tag stays neutral.

export type Tone = "ok" | "warn" | "fail" | "info" | "neutral"

export function Tag({ tone, children }: { tone: Tone; children: string }) {
  return <span className={tone === "neutral" ? "ui-tag" : `ui-tag ui-tag-${tone}`}>{children}</span>
}
