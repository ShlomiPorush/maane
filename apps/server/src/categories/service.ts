// Categories (plan 4.1): one shared list, managed by admins on their own page. Every write runs in one transaction with
// its audit row. Deleting a category removes it from every ticket (ticket_category cascades with it).

import { CATEGORY_NAME_MAX, type CategoryRef, type CategoryView } from "@maane/shared"
import { asc, count, eq, sql } from "drizzle-orm"
import { writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import { category, ticketCategory } from "../db/schema.ts"
import { refuseImportedCategory } from "../imports/window.ts"
import { databaseError, Refusal } from "../organizations/refusal.ts"
import { type Acting, hidden } from "../organizations/service.ts"

/** A name as stored (trimmed), or a refusal: 1 to 80 characters, no control or direction characters. */
export function parseCategoryName(text: unknown): string {
  const name = typeof text === "string" ? text.trim() : ""
  const length = [...name].length
  if (length < 1 || length > CATEGORY_NAME_MAX || [...name].some((char) => hidden(char.codePointAt(0) ?? 0)))
    throw new Refusal("category_name_invalid", 400, { field: "name", max: CATEGORY_NAME_MAX })
  return name
}

const nameTaken = (error: unknown) =>
  databaseError(error)?.code === "23505" ? new Refusal("category_name_taken", 409, { field: "name" }) : null

export class Categories {
  constructor(private readonly db: Db) {}

  /** Every category by name, for a picker or a filter. */
  async refs(db: Pick<Db, "select"> = this.db): Promise<CategoryRef[]> {
    return db
      .select({ id: category.id, name: category.name })
      .from(category)
      .orderBy(sql`lower(${category.name})`, asc(category.id))
  }

  /** The admin list: every category with how many tickets carry it. */
  async list(): Promise<CategoryView[]> {
    const used = this.db
      .select({ categoryId: ticketCategory.categoryId, n: count().as("n") })
      .from(ticketCategory)
      .groupBy(ticketCategory.categoryId)
      .as("used")
    const rows = await this.db
      .select({
        id: category.id,
        name: category.name,
        createdAt: category.createdAt,
        tickets: sql<number>`coalesce(${used.n}, 0)`.mapWith(Number),
      })
      .from(category)
      .leftJoin(used, eq(used.categoryId, category.id))
      .orderBy(sql`lower(${category.name})`, asc(category.id))
    return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
  }

  async create(nameText: unknown, acting: Acting): Promise<CategoryRef> {
    const name = parseCategoryName(nameText)
    try {
      return await this.db.transaction(async (tx) => {
        const [created] = await tx.insert(category).values({ name }).returning({ id: category.id, name: category.name })
        if (!created) throw new Error("insert returned no row")
        await writeAudit(tx, acting.actor, {
          action: "category.create",
          entityType: "category",
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
    const name = parseCategoryName(nameText)
    try {
      await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ name: category.name })
          .from(category)
          .where(eq(category.id, id))
          .for("update")
        if (!current) throw new Refusal("category_not_found", 404)
        if (current.name === name) return
        await tx.update(category).set({ name }).where(eq(category.id, id))
        await writeAudit(tx, acting.actor, {
          action: "category.rename",
          entityType: "category",
          entityId: id,
          details: { name, previous: current.name },
          ipAddress: acting.ipAddress,
        })
      })
    } catch (error) {
      throw nameTaken(error) ?? error
    }
  }

  /**
   * Deletes a category; every ticket that carried it loses it in the same transaction. Refused while an imported
   * ticket carries it and the import is not finished.
   */
  async delete(id: string, acting: Acting): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [current] = await tx.select({ name: category.name }).from(category).where(eq(category.id, id)).for("update")
      if (!current) throw new Refusal("category_not_found", 404)
      // It would change an imported ticket, which is read-only for agents until the import is finished (plan 5.1).
      await refuseImportedCategory(tx, id)
      await tx.delete(category).where(eq(category.id, id))
      await writeAudit(tx, acting.actor, {
        action: "category.delete",
        entityType: "category",
        entityId: id,
        details: { name: current.name },
        ipAddress: acting.ipAddress,
      })
    })
  }
}
