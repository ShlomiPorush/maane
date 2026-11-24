// The import page's routes (plan 5.1), mounted under /api/v1/admin/import behind its session, two-factor, CSRF, and
// Origin checks: admins only. A refusal answers {error: code, ...details} with a stable code
// (apps/web/src/api/errors.ts explains each one).

import { Hono } from "hono"
import { z } from "zod"
import type { Imports } from "../imports/service.ts"
import { Refusal } from "../organizations/refusal.ts"
import { type ApiEnv, clientIp } from "./request.ts"

const MappingBody = z.object({
  brands: z.record(z.string(), z.string().nullable()),
  tags: z.record(z.string(), z.string().nullable()),
  agentUserId: z.string().min(1).max(200).nullable(),
})

/** Cancel names the run the admin confirmed, so a stale dialog cannot cancel a newer run. */
const CancelBody = z.object({ runId: z.string().max(100) })

export function importRoutes(imports: Imports): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>()

  routes.get("/", async (c) => c.json(await imports.view()))

  routes.get("/run", async (c) => c.json({ run: await imports.latest() }))

  routes.put("/mapping", async (c) => {
    const parsed = MappingBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Refusal("request_invalid", 400)
    await imports.saveMapping(parsed.data, { actor: c.get("actor"), ipAddress: clientIp(c.req.raw) })
    return c.json({ ok: true })
  })

  routes.post("/start", async (c) => c.json({ run: await imports.start(c.get("user").id) }, 202))

  routes.post("/finish", async (c) => {
    await imports.finish({ actor: c.get("actor"), ipAddress: clientIp(c.req.raw) })
    return c.json(await imports.view())
  })

  routes.post("/cancel", async (c) => {
    const parsed = CancelBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) throw new Refusal("request_invalid", 400)
    const acting = { actor: c.get("actor"), ipAddress: clientIp(c.req.raw) }
    return c.json(await imports.cancel(parsed.data.runId, acting))
  })

  routes.get("/runs/:id/report", async (c) =>
    c.json(await imports.report(c.req.param("id") ?? "", c.req.query("after"))),
  )

  return routes
}
