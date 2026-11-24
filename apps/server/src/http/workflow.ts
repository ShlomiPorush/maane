// The workflow of plans 4.1 and 4.2, mounted under /api/v1 behind its session, two-factor, CSRF, and Origin checks: a
// ticket's status, categories, organization, and snooze (any user, within their scope, read on each request; a ticket
// outside it answers 404), and the categories themselves at /admin/categories (admins only). A refusal answers
// {error: code, ...details} with a stable code (apps/web/src/api/errors.ts explains each one).

import { TICKET_STATUSES } from "@maane/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { Categories } from "../categories/service.ts"
import type { Db } from "../db/client.ts"
import type { JobQueue } from "../jobs/queue.ts"
import { Refusal } from "../organizations/refusal.ts"
import { visibleOrganizations } from "../organizations/scope.ts"
import { Snoozes } from "../tickets/snooze.ts"
import { Workflow, type WorkflowUser } from "../tickets/workflow.ts"
import { type ApiEnv, clientIp } from "./request.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NUMBER = /^[1-9][0-9]{0,15}$/

const StatusBody = z.object({ status: z.enum(TICKET_STATUSES) })
const CategoriesBody = z.object({ categories: z.array(z.string().regex(UUID)) })
const MoveBody = z.object({ organizationId: z.string().regex(UUID) })
const NameBody = z.object({ name: z.string() })
/** A snooze's end, as an instant with its offset (the UI enters it in Israel time). */
const SnoozeBody = z.object({ until: z.iso.datetime({ offset: true }) })

async function body<T>(c: Context<ApiEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new Refusal("request_invalid", 400)
  return parsed.data
}

/** The ticket number in the path, or a 404 refusal. */
function numberOf(c: Context<ApiEnv>): number {
  const text = c.req.param("number") ?? ""
  const number = NUMBER.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(number)) throw new Refusal("not_found", 404)
  return number
}

export function workflowRoutes(db: Db, jobs: JobQueue): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>()
  const workflow = new Workflow(db, jobs)
  const snoozes = new Snoozes(db, jobs)
  const categories = new Categories(db)
  const scopeOf = (c: Context<ApiEnv>) => visibleOrganizations(db, c.get("user"))
  const userOf = (c: Context<ApiEnv>): WorkflowUser => ({
    id: c.get("user").id,
    role: c.get("user").role,
    actor: c.get("actor"),
    ipAddress: clientIp(c.req.raw),
  })
  const acting = (c: Context<ApiEnv>) => ({ actor: c.get("actor"), ipAddress: clientIp(c.req.raw) })
  const categoryId = (c: Context<ApiEnv>) => {
    const id = c.req.param("id") ?? ""
    if (!UUID.test(id)) throw new Refusal("category_not_found", 404)
    return id
  }

  routes.put("/tickets/:number/status", async (c) => {
    const number = numberOf(c)
    const { status } = await body(c, StatusBody)
    await workflow.setStatus(await scopeOf(c), userOf(c), number, status)
    return c.json({ ok: true })
  })

  routes.put("/tickets/:number/categories", async (c) => {
    const number = numberOf(c)
    const { categories: ids } = await body(c, CategoriesBody)
    await workflow.setCategories(await scopeOf(c), userOf(c), number, ids)
    return c.json({ ok: true })
  })

  routes.put("/tickets/:number/organization", async (c) => {
    const number = numberOf(c)
    const { organizationId } = await body(c, MoveBody)
    await workflow.move(await scopeOf(c), userOf(c), number, organizationId)
    return c.json({ ok: true })
  })

  routes.put("/tickets/:number/snooze", async (c) => {
    const number = numberOf(c)
    const { until } = await body(c, SnoozeBody)
    await snoozes.snooze(await scopeOf(c), userOf(c), number, new Date(until))
    return c.json({ ok: true })
  })

  routes.delete("/tickets/:number/snooze", async (c) => {
    await snoozes.wake(await scopeOf(c), userOf(c), numberOf(c))
    return c.json({ ok: true })
  })

  routes.get("/admin/categories", async (c) => c.json({ categories: await categories.list() }))

  routes.post("/admin/categories", async (c) => {
    const { name } = await body(c, NameBody)
    return c.json({ category: await categories.create(name, acting(c)) }, 201)
  })

  routes.patch("/admin/categories/:id", async (c) => {
    const id = categoryId(c)
    const { name } = await body(c, NameBody)
    await categories.rename(id, name, acting(c))
    return c.json({ ok: true })
  })

  routes.delete("/admin/categories/:id", async (c) => {
    await categories.delete(categoryId(c), acting(c))
    return c.json({ ok: true })
  })

  return routes
}
