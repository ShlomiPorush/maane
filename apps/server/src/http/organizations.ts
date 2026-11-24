import { ADDRESS_KINDS } from "@maane/shared"
import { type Context, Hono } from "hono"
import { z } from "zod"
import { Refusal } from "../organizations/refusal.ts"
import type { Acting, Organizations } from "../organizations/service.ts"
import { type ApiEnv, clientIp } from "./request.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const NameBody = z.object({ name: z.string() })
const MemberBody = z.object({ userId: z.string() })
const SignatureBody = z.object({ signature: z.string() })
const ReminderBody = z.object({ template: z.string(), days: z.number() })
const AddressBody = z.object({ kind: z.enum(ADDRESS_KINDS), value: z.string() })

function idParam(c: Context<ApiEnv>, name: "id" | "addressId" | "userId", notFound: string): string {
  const value = c.req.param(name) ?? ""
  if (name !== "userId" && !UUID.test(value)) throw new Refusal(notFound, 404)
  if (name === "userId" && (value.length === 0 || value.length > 200)) throw new Refusal(notFound, 404)
  return name === "userId" ? value : value.toLowerCase()
}

async function body<T>(c: Context<ApiEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) throw new Refusal("request_invalid", 400)
  return parsed.data
}

export function organizationRoutes(organizations: Organizations): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>()
  const acting = (c: Context<ApiEnv>): Acting => ({ actor: c.get("actor"), ipAddress: clientIp(c.req.raw) })

  routes.get("/", async (c) => c.json({ organizations: await organizations.list() }))

  routes.post("/", async (c) => {
    const { name } = await body(c, NameBody)
    return c.json({ organization: await organizations.create(name, acting(c)) }, 201)
  })

  routes.get("/address-check", async (c) => c.json(await organizations.checkAddress(c.req.query("address") ?? "")))

  routes.get("/:id", async (c) => c.json(await organizations.get(idParam(c, "id", "organization_not_found"))))

  routes.patch("/:id", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    const { name } = await body(c, NameBody)
    await organizations.rename(id, name, acting(c))
    return c.json({ ok: true })
  })

  routes.put("/:id/signature", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    const { signature } = await body(c, SignatureBody)
    await organizations.setSignature(id, signature, acting(c))
    return c.json({ ok: true })
  })

  routes.put("/:id/reminder", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    const { template, days } = await body(c, ReminderBody)
    await organizations.setReminder(id, { template, days }, acting(c))
    return c.json({ ok: true })
  })

  routes.delete("/:id", async (c) => {
    await organizations.delete(idParam(c, "id", "organization_not_found"), acting(c))
    return c.json({ ok: true })
  })

  routes.post("/:id/members", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    const { userId } = await body(c, MemberBody)
    await organizations.addMember(id, userId, acting(c))
    return c.json({ ok: true }, 201)
  })

  routes.delete("/:id/members/:userId", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    await organizations.removeMember(id, idParam(c, "userId", "member_not_found"), acting(c))
    return c.json({ ok: true })
  })

  routes.post("/:id/addresses", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    const { kind, value } = await body(c, AddressBody)
    return c.json({ address: await organizations.addAddress(id, kind, value, acting(c)) }, 201)
  })

  routes.delete("/:id/addresses/:addressId", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    await organizations.removeAddress(id, idParam(c, "addressId", "address_not_found"), acting(c))
    return c.json({ ok: true })
  })

  routes.put("/:id/addresses/:addressId/default", async (c) => {
    const id = idParam(c, "id", "organization_not_found")
    await organizations.setDefault(id, idParam(c, "addressId", "address_not_found"), acting(c))
    return c.json({ ok: true })
  })

  return routes
}
