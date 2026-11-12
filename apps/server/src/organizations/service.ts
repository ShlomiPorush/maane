// Organizations, their support addresses, and agent membership: the admin's writes and reads (plan 2.1). Every write
// runs in one transaction with its audit row. The database holds the invariants as well (unique names and values, one
// default that is exact, foreign keys that keep an organization in use from being deleted), so a race between two
// admins ends in a refusal, never in a broken state; this service turns those refusals into stable codes.

import {
  type AddressKind,
  ORGANIZATION_NAME_MAX,
  parseExactAddress,
  parseSupportAddress,
  resolveSupportAddress,
} from "@maane/shared"
import { and, asc, count, desc, eq, sql } from "drizzle-orm"
import { type Actor, writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { authUser, organization, organizationMember, supportAddress } from "../db/schema.ts"
import { intakeModeIn, lockIntakeConfig } from "./intake.ts"
import { databaseError, Refusal } from "./refusal.ts"

export const NAME_MAX = ORGANIZATION_NAME_MAX

export type OrganizationSummary = {
  id: string
  name: string
  createdAt: Date
  addresses: number
  members: number
  /** The organization holds the default address. */
  hasDefault: boolean
}

export type AddressRow = { id: string; kind: AddressKind; value: string; isDefault: boolean; createdAt: Date }
export type MemberRow = { userId: string; username: string; role: string; banned: boolean; createdAt: Date }

export type AddressCheck = {
  address: string
  via: "exact" | "pattern" | "default" | "none"
  organization: { id: string; name: string } | null
  rule: { id: string; kind: AddressKind; value: string } | null
}

/** Who acted and from where, for the audit row. */
export type Acting = { actor: Actor; ipAddress: string | null }

// Control characters, and the characters that reorder text (bidirectional marks and isolates): a name shows in
// lists, sender names, and audit rows, where either could hide or disguise what it says.
function hidden(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x61c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** A name as stored (trimmed), or a refusal: 1 to 80 characters, no control or direction characters. */
export function parseName(text: unknown): string {
  const name = typeof text === "string" ? text.trim() : ""
  const length = [...name].length
  if (length < 1 || length > NAME_MAX || [...name].some((char) => hidden(char.codePointAt(0) ?? 0)))
    throw new Refusal("organization_name_invalid", 400, { field: "name", max: NAME_MAX })
  return name
}

export class Organizations {
  constructor(private readonly db: Db) {}

  async list(): Promise<OrganizationSummary[]> {
    const addresses = this.db
      .select({
        organizationId: supportAddress.organizationId,
        n: count().as("n"),
        hasDefault: sql<boolean>`bool_or(${supportAddress.isDefault})`.as("has_default"),
      })
      .from(supportAddress)
      .groupBy(supportAddress.organizationId)
      .as("a")
    const members = this.db
      .select({ organizationId: organizationMember.organizationId, n: count().as("m") })
      .from(organizationMember)
      .groupBy(organizationMember.organizationId)
      .as("m")
    const rows = await this.db
      .select({
        id: organization.id,
        name: organization.name,
        createdAt: organization.createdAt,
        addresses: sql<number>`coalesce(${addresses.n}, 0)`.mapWith(Number),
        members: sql<number>`coalesce(${members.n}, 0)`.mapWith(Number),
        hasDefault: sql<boolean>`coalesce(${addresses.hasDefault}, false)`.mapWith(Boolean),
      })
      .from(organization)
      .leftJoin(addresses, eq(addresses.organizationId, organization.id))
      .leftJoin(members, eq(members.organizationId, organization.id))
      .orderBy(sql`lower(${organization.name})`, asc(organization.id))
    return rows
  }

  /** One organization with its addresses (the default first, then exact, then patterns) and its members. */
  async get(id: string): Promise<{
    organization: { id: string; name: string; createdAt: Date }
    addresses: AddressRow[]
    members: MemberRow[]
  }> {
    const [found] = await this.db
      .select({ id: organization.id, name: organization.name, createdAt: organization.createdAt })
      .from(organization)
      .where(eq(organization.id, id))
    if (!found) throw new Refusal("organization_not_found", 404)
    const addresses = await this.db
      .select({
        id: supportAddress.id,
        kind: supportAddress.kind,
        value: supportAddress.value,
        isDefault: supportAddress.isDefault,
        createdAt: supportAddress.createdAt,
      })
      .from(supportAddress)
      .where(eq(supportAddress.organizationId, id))
      .orderBy(desc(supportAddress.isDefault), asc(supportAddress.kind), asc(supportAddress.value))
    const members = await this.db
      .select({
        userId: organizationMember.userId,
        username: sql<string>`coalesce(${authUser.username}, ${authUser.name})`,
        role: sql<string>`coalesce(${authUser.role}, 'agent')`,
        banned: sql<boolean>`coalesce(${authUser.banned}, false)`.mapWith(Boolean),
        createdAt: organizationMember.createdAt,
      })
      .from(organizationMember)
      .innerJoin(authUser, eq(authUser.id, organizationMember.userId))
      .where(eq(organizationMember.organizationId, id))
      .orderBy(asc(authUser.username))
    return { organization: found, addresses: addresses as AddressRow[], members }
  }

  async create(nameText: unknown, acting: Acting): Promise<{ id: string; name: string }> {
    const name = parseName(nameText)
    try {
      return await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(organization)
          .values({ name })
          .returning({ id: organization.id, name: organization.name })
        if (!created) throw new Error("insert returned no row")
        await writeAudit(tx, acting.actor, {
          action: "organization.create",
          entityType: "organization",
          entityId: created.id,
          details: { name },
          ipAddress: acting.ipAddress,
        })
        return created
      })
    } catch (error) {
      throw nameTaken(error) ?? error
    }
  }

  async rename(id: string, nameText: unknown, acting: Acting): Promise<void> {
    const name = parseName(nameText)
    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, id))
          .for("update")
        if (!current) throw new Refusal("organization_not_found", 404)
        if (current.name === name) return
        await tx.update(organization).set({ name }).where(eq(organization.id, id))
        await writeAudit(tx, acting.actor, {
          action: "organization.rename",
          entityType: "organization",
          entityId: id,
          details: { name, previous: current.name },
          ipAddress: acting.ipAddress,
        })
      })
    } catch (error) {
      throw nameTaken(error) ?? error
    }
  }

  /** Refused while the organization has an address or a member (later also a ticket: its foreign key restricts). */
  async delete(id: string, acting: Acting): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ name: organization.name })
          .from(organization)
          .where(eq(organization.id, id))
          .for("update")
        if (!current) throw new Refusal("organization_not_found", 404)
        const [addresses] = await tx
          .select({ n: count() })
          .from(supportAddress)
          .where(eq(supportAddress.organizationId, id))
        const [members] = await tx
          .select({ n: count() })
          .from(organizationMember)
          .where(eq(organizationMember.organizationId, id))
        if ((addresses?.n ?? 0) > 0 || (members?.n ?? 0) > 0)
          throw new Refusal("organization_in_use", 409, { addresses: addresses?.n ?? 0, members: members?.n ?? 0 })
        await tx.delete(organization).where(eq(organization.id, id))
        await writeAudit(tx, acting.actor, {
          action: "organization.delete",
          entityType: "organization",
          entityId: id,
          details: { name: current.name },
          ipAddress: acting.ipAddress,
        })
      })
    } catch (error) {
      // Anything that refers to the organization and was not counted above (a ticket, from phase 2.3 on).
      if (databaseError(error)?.code === "23503") throw new Refusal("organization_in_use", 409)
      throw error
    }
  }

  /** Adds an agent. Admins need no membership: they see every organization by their role. */
  async addMember(id: string, userId: unknown, acting: Acting): Promise<void> {
    if (typeof userId !== "string" || userId.length === 0 || userId.length > 200)
      throw new Refusal("member_not_agent", 400)
    try {
      await this.db.transaction(async (tx) => {
        const name = await organizationName(tx, id)
        const [user] = await tx
          .select({ username: authUser.username, name: authUser.name, role: authUser.role })
          .from(authUser)
          .where(eq(authUser.id, userId))
        if (!user || (user.role ?? "agent") !== "agent") throw new Refusal("member_not_agent", 400)
        await tx.insert(organizationMember).values({ organizationId: id, userId })
        await writeAudit(tx, acting.actor, {
          action: "organization.member_add",
          entityType: "organization",
          entityId: id,
          details: { name, userId, username: user.username ?? user.name },
          ipAddress: acting.ipAddress,
        })
      })
    } catch (error) {
      const failure = databaseError(error)
      if (failure?.code === "23505") throw new Refusal("member_exists", 409)
      if (failure?.code === "23503") throw new Refusal("organization_not_found", 404)
      throw error
    }
  }

  async removeMember(id: string, userId: string, acting: Acting): Promise<void> {
    await this.db.transaction(async (tx) => {
      const name = await organizationName(tx, id)
      const [removed] = await tx
        .delete(organizationMember)
        .where(and(eq(organizationMember.organizationId, id), eq(organizationMember.userId, userId)))
        .returning({ userId: organizationMember.userId })
      if (!removed) throw new Refusal("member_not_found", 404)
      const [user] = await tx
        .select({ username: authUser.username, name: authUser.name })
        .from(authUser)
        .where(eq(authUser.id, userId))
      await writeAudit(tx, acting.actor, {
        action: "organization.member_remove",
        entityType: "organization",
        entityId: id,
        details: { name, userId, username: user?.username ?? user?.name ?? null },
        ipAddress: acting.ipAddress,
      })
    })
  }

  async addAddress(id: string, kind: AddressKind, text: unknown, acting: Acting): Promise<{ id: string }> {
    const parsed = parseSupportAddress(kind, typeof text === "string" ? text : "")
    if (!parsed.ok) throw new Refusal(parsed.code, 400, { field: "value" })
    try {
      return await this.db.transaction(async (tx) => {
        const name = await organizationName(tx, id)
        const [created] = await tx
          .insert(supportAddress)
          .values({ organizationId: id, kind, value: parsed.value })
          .returning({ id: supportAddress.id })
        if (!created) throw new Error("insert returned no row")
        await writeAudit(tx, acting.actor, {
          action: "organization.address_add",
          entityType: "organization",
          entityId: id,
          details: { name, kind, value: parsed.value },
          ipAddress: acting.ipAddress,
        })
        return created
      })
    } catch (error) {
      const failure = databaseError(error)
      if (failure?.code === "23505") throw new Refusal("address_taken", 409, { field: "value" })
      if (failure?.code === "23503") throw new Refusal("organization_not_found", 404)
      throw error
    }
  }

  /** Refused for the default address while the intake mode is live: it can only be replaced (P17). */
  async removeAddress(id: string, addressId: string, acting: Acting): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockIntakeConfig(tx)
      const name = await organizationName(tx, id)
      const row = await addressOf(tx, id, addressId)
      if (row.isDefault && (await intakeModeIn(tx)) === "live") throw new Refusal("intake_default_required", 409)
      await tx.delete(supportAddress).where(eq(supportAddress.id, addressId))
      await writeAudit(tx, acting.actor, {
        action: "organization.address_remove",
        entityType: "organization",
        entityId: id,
        details: { name, kind: row.kind, value: row.value, wasDefault: row.isDefault },
        ipAddress: acting.ipAddress,
      })
    })
  }

  /** Makes an exact address the default, replacing the previous default in the same transaction. */
  async setDefault(id: string, addressId: string, acting: Acting): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockIntakeConfig(tx)
      const name = await organizationName(tx, id)
      const row = await addressOf(tx, id, addressId)
      if (row.kind !== "exact") throw new Refusal("address_default_not_exact", 400)
      if (row.isDefault) return
      // Two statements, in this order: the partial unique index allows one default at any moment.
      const previous = await tx
        .update(supportAddress)
        .set({ isDefault: false })
        .where(eq(supportAddress.isDefault, true))
        .returning({ value: supportAddress.value })
      await tx.update(supportAddress).set({ isDefault: true }).where(eq(supportAddress.id, addressId))
      await writeAudit(tx, acting.actor, {
        action: "organization.address_default",
        entityType: "organization",
        entityId: id,
        details: { name, value: row.value, previous: previous[0]?.value ?? null },
        ipAddress: acting.ipAddress,
      })
    })
  }

  /** "Which organization gets this address?": the same function the intake uses, over every stored address. */
  async checkAddress(text: unknown): Promise<AddressCheck> {
    const parsed = parseExactAddress(typeof text === "string" ? text : "")
    if (!parsed.ok) throw new Refusal("address_invalid", 400, { field: "address" })
    const rules = await this.db
      .select({
        id: supportAddress.id,
        kind: supportAddress.kind,
        value: supportAddress.value,
        isDefault: supportAddress.isDefault,
        organizationId: organization.id,
        organizationName: organization.name,
      })
      .from(supportAddress)
      .innerJoin(organization, eq(organization.id, supportAddress.organizationId))
    const result = resolveSupportAddress([parsed.value], rules as ((typeof rules)[number] & { kind: AddressKind })[])
    if (result.via === "none") return { address: parsed.value, via: "none", organization: null, rule: null }
    const { rule } = result
    return {
      address: parsed.value,
      via: result.via,
      organization: { id: rule.organizationId, name: rule.organizationName },
      rule: { id: rule.id, kind: rule.kind, value: rule.value },
    }
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The organization's name, read with a key-share lock so it cannot be deleted before the transaction ends. */
async function organizationName(tx: Tx, id: string): Promise<string> {
  const [row] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, id))
    .for("key share")
  if (!row) throw new Refusal("organization_not_found", 404)
  return row.name
}

async function addressOf(tx: Tx, id: string, addressId: string) {
  const [row] = await tx
    .select({ kind: supportAddress.kind, value: supportAddress.value, isDefault: supportAddress.isDefault })
    .from(supportAddress)
    .where(and(eq(supportAddress.id, addressId), eq(supportAddress.organizationId, id)))
    .for("update")
  if (!row) throw new Refusal("address_not_found", 404)
  return row
}

function nameTaken(error: unknown): Refusal | null {
  return databaseError(error)?.code === "23505" ? new Refusal("organization_name_taken", 409, { field: "name" }) : null
}
