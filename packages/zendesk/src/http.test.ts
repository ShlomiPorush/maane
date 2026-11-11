import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { tokenAuthorization, ZendeskClient } from "./http.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maane-http-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A fetch that records what it was asked and answers from a table of URLs. */
function fakeFetch(answers: Record<string, () => Response>) {
  const calls: { url: string; authorization: string | null }[] = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    const answer = answers[url]
    if (!answer) throw new TypeError("fetch failed")
    return answer()
  }) as typeof fetch
  return { fetchImpl, calls }
}

const api = "https://example.zendesk.com"

describe("ZendeskClient", () => {
  it("builds Zendesk's token authorization", () => {
    expect(tokenAuthorization("agent@example.com", "abc")).toBe(
      `Basic ${Buffer.from("agent@example.com/token:abc").toString("base64")}`,
    )
  })

  it("refuses an API origin without HTTPS", () => {
    expect(() => new ZendeskClient({ apiOrigin: "http://example.zendesk.com", authorization: "x" })).toThrow("HTTPS")
  })

  it("refuses a download over plain HTTP, also after a redirect, and never sends the token to another host", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`${api}/attachments/token/a/`]: () =>
        new Response(null, { status: 302, headers: { Location: "http://files.example.net/a" } }),
      [`${api}/attachments/token/b/`]: () =>
        new Response(null, { status: 302, headers: { Location: "https://files.example.net/b" } }),
      "https://files.example.net/b": () => new Response("content"),
    })
    const client = new ZendeskClient({ apiOrigin: api, authorization: "Basic secret", fetch: fetchImpl })
    await expect(client.download("http://example.zendesk.com/x", join(dir, "x"), 100)).rejects.toThrow("HTTPS")
    await expect(client.download(`${api}/attachments/token/a/`, join(dir, "a"), 100)).rejects.toThrow("HTTPS")
    await expect(stat(join(dir, "a"))).rejects.toThrow()

    const result = await client.download(`${api}/attachments/token/b/`, join(dir, "b"), 100)
    expect(result.bytes).toBe(7)
    expect(calls.find((c) => c.url === `${api}/attachments/token/b/`)?.authorization).toBe("Basic secret")
    expect(calls.find((c) => c.url === "https://files.example.net/b")?.authorization).toBeNull()
  })

  it("stops a download above the size limit and leaves no file", async () => {
    const { fetchImpl } = fakeFetch({ [`${api}/f`]: () => new Response("x".repeat(50)) })
    const client = new ZendeskClient({ apiOrigin: api, authorization: "x", fetch: fetchImpl })
    await expect(client.download(`${api}/f`, join(dir, "f"), 10)).rejects.toThrow("larger than the limit")
    await expect(stat(join(dir, "f"))).rejects.toThrow()
  })

  it("retries a rate limit and a server error, then gives up with the status", async () => {
    let n = 0
    const { fetchImpl } = fakeFetch({
      [`${api}/api/v2/groups.json`]: () =>
        ++n === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "1" } })
          : n === 2
            ? new Response(null, { status: 503 })
            : new Response('{"groups":[]}'),
      [`${api}/api/v2/brands.json`]: () => new Response(null, { status: 502 }),
    })
    const waits: number[] = []
    const client = new ZendeskClient({
      apiOrigin: api,
      authorization: "x",
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
      maxAttempts: 3,
    })
    expect((await client.getJson("/api/v2/groups.json")).json).toEqual({ groups: [] })
    expect(waits[0]).toBe(1000)
    await expect(client.getJson("/api/v2/brands.json")).rejects.toThrow("502")
  })

  it("never puts the token or the host in an error message", async () => {
    const { fetchImpl } = fakeFetch({ [`${api}/api/v2/tags.json`]: () => new Response("nope", { status: 401 }) })
    const client = new ZendeskClient({ apiOrigin: api, authorization: "Basic secret-value", fetch: fetchImpl })
    const error = await client.getJson("/api/v2/tags.json").catch((e: Error) => e)
    expect(String(error)).not.toContain("secret-value")
    expect(String(error)).not.toContain("example.zendesk.com")
    expect(String(error)).toContain("401 for /api/v2/tags.json")
  })
})
