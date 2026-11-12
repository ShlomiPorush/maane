// Better Auth's client reports a 401 answer to the app through its documented fetchOptions.onError, so a session that
// ended while the page stayed open leads to sign-in as it does for Maane's own API. The client reads `fetch` when it
// is created, so the stand-in is in place before the module loads.

import { afterEach, describe, expect, it, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("Better Auth's answers", () => {
  it("reports a 401 to the app, and no other answer", async () => {
    let status = 401
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(status === 200 ? "[]" : JSON.stringify({ code: "UNAUTHORIZED" }), {
            status,
            headers: { "content-type": "application/json" },
          }),
      ),
    )
    vi.resetModules()
    const { authClient, onAuthUnauthorized } = await import("./auth.ts")
    const seen = vi.fn()
    onAuthUnauthorized(seen)
    await authClient.listSessions()
    expect(seen).toHaveBeenCalledTimes(1)
    for (status of [400, 403, 500, 200]) await authClient.listSessions()
    expect(seen).toHaveBeenCalledTimes(1)
    onAuthUnauthorized(null)
  })
})
