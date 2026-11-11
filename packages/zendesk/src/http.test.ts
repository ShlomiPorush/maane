import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isZendeskFileHost, tokenAuthorization, ZendeskClient } from "./http.ts"

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
const content = "https://acme.zdusercontent.com"
const noWait = async () => {}

describe("ZendeskClient", () => {
  it("builds Zendesk's token authorization", () => {
    expect(tokenAuthorization("agent@example.com", "abc")).toBe(
      `Basic ${Buffer.from("agent@example.com/token:abc").toString("base64")}`,
    )
  })

  it("refuses an API origin without HTTPS", () => {
    expect(() => new ZendeskClient({ apiOrigin: "http://example.zendesk.com", authorization: "x" })).toThrow("HTTPS")
  })

  it("allows file downloads from Zendesk's hosts only", () => {
    expect(isZendeskFileHost("acme.zendesk.com")).toBe(true)
    expect(isZendeskFileHost("acme.zdusercontent.com")).toBe(true)
    expect(isZendeskFileHost("zendesk.com.example.net")).toBe(false)
    expect(isZendeskFileHost("intranet.local")).toBe(false)
  })

  it("refuses plain HTTP and other hosts, also after a redirect, and never sends the token to another host", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`${api}/attachments/token/a/`]: () =>
        new Response(null, { status: 302, headers: { Location: "http://acme.zdusercontent.com/a" } }),
      [`${api}/attachments/token/b/`]: () => new Response(null, { status: 302, headers: { Location: `${content}/b` } }),
      [`${api}/attachments/token/c/`]: () =>
        new Response(null, { status: 302, headers: { Location: "https://192.0.2.5/c" } }),
      [`${content}/b`]: () => new Response("content"),
    })
    const client = new ZendeskClient({ apiOrigin: api, authorization: "Basic secret", fetch: fetchImpl, sleep: noWait })
    await expect(client.download("http://example.zendesk.com/x", join(dir, "x"), 100, null)).rejects.toThrow("HTTPS")
    await expect(client.download(`${api}/attachments/token/a/`, join(dir, "a"), 100, null)).rejects.toThrow("HTTPS")
    await expect(client.download(`${api}/attachments/token/c/`, join(dir, "c"), 100, null)).rejects.toThrow(
      "not Zendesk's",
    )
    await expect(stat(join(dir, "a"))).rejects.toThrow()

    const result = await client.download(`${api}/attachments/token/b/`, join(dir, "b"), 100, 7)
    expect(result.bytes).toBe(7)
    expect(calls.find((c) => c.url === `${api}/attachments/token/b/`)?.authorization).toBe("Basic secret")
    expect(calls.find((c) => c.url === `${content}/b`)?.authorization).toBeNull()
  })

  it("refuses a file over the limit, of another size than Zendesk reported, or answered in part", async () => {
    const { fetchImpl } = fakeFetch({
      [`${api}/big`]: () => new Response("x".repeat(50)),
      [`${api}/short`]: () => new Response("x".repeat(5)),
      [`${api}/partial`]: () => new Response("x".repeat(5), { status: 206 }),
    })
    const client = new ZendeskClient({ apiOrigin: api, authorization: "x", fetch: fetchImpl, sleep: noWait })
    await expect(client.download(`${api}/big`, join(dir, "big"), 10, null)).rejects.toThrow("larger than the limit")
    await expect(client.download(`${api}/short`, join(dir, "short"), 100, 9)).rejects.toThrow("Zendesk reported 9")
    await expect(client.download(`${api}/partial`, join(dir, "partial"), 100, null)).rejects.toThrow("206")
    for (const name of ["big", "short", "partial"]) await expect(stat(join(dir, name))).rejects.toThrow()
  })

  it("retries a download after a rate limit, honoring Retry-After", async () => {
    let n = 0
    const { fetchImpl } = fakeFetch({
      [`${api}/f`]: () =>
        ++n === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "2" } }) : new Response("ok"),
    })
    const waits: number[] = []
    const client = new ZendeskClient({
      apiOrigin: api,
      authorization: "x",
      fetch: fetchImpl,
      sleep: async (ms) => void waits.push(ms),
    })
    expect((await client.download(`${api}/f`, join(dir, "f"), 100, 2)).bytes).toBe(2)
    expect(waits).toEqual([2000])
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
