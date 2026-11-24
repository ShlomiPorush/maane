import {
  emptyImportCounts,
  IMPORT_FAILURES,
  IMPORT_REPORT_PAGE_SIZE,
  IMPORT_STAGES,
  type ImportArchiveView,
  type ImportCounts,
  type ImportFailure,
  type ImportMappingInput,
  type ImportReportPage,
  type ImportReportReason,
  type ImportRunState,
  type ImportRunView,
  type ImportStage,
  type ImportStopReason,
  type ImportView,
} from "@maane/shared"
import { ArchiveReader } from "@maane/zendesk"
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm"
import { writeAudit } from "../audit.ts"
import type { Db } from "../db/client.ts"
import {
  authUser,
  category,
  importReport,
  importRun,
  organization,
  zendeskBrandMap,
  zendeskImport,
  zendeskTagMap,
} from "../db/schema.ts"
import { type JobQueue, transactionWithJobs, ZENDESK_IMPORT, ZENDESK_IMPORT_HEARTBEAT_SECONDS } from "../jobs/queue.ts"
import { log } from "../log.ts"
import { Refusal } from "../organizations/refusal.ts"
import type { Acting } from "../organizations/service.ts"
import { finishImport, importWindow } from "./window.ts"

const BRAND_ID = /^\d{1,20}$/
const TAG_MAX = 200
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type RunRow = typeof importRun.$inferSelect

const HEARTBEAT = { heartbeatSeconds: ZENDESK_IMPORT_HEARTBEAT_SECONDS }

interface ArchiveSummary {
  archive: Omit<ImportArchiveView, "otherOrigin">
  brands: Map<string, { name: string; tickets: number }>
  tags: Map<string, number>
}

function failureView(value: string | null): ImportRunView["failure"] {
  const [stage = "", kind = "", constraint = ""] = (value ?? "").split(":")
  if (!(IMPORT_STAGES as readonly string[]).includes(stage)) return null
  return {
    stage: stage as ImportStage,
    kind: (IMPORT_FAILURES as readonly string[]).includes(kind) ? (kind as ImportFailure) : "other",
    constraint: /^[a-z0-9_]{1,63}$/.test(constraint) ? constraint : null,
  }
}

export class Imports {
  #cached: { key: string; summary: ArchiveSummary } | null = null

  constructor(
    private readonly db: Db,
    private readonly jobs: JobQueue,
    private readonly archiveDir: string,
  ) {}

  async #summary(): Promise<ArchiveSummary> {
    const empty: ArchiveSummary = {
      archive: { present: false, origin: null, runs: 0, coveredUntil: null, backupRunning: false, tickets: 0 },
      brands: new Map(),
      tags: new Map(),
    }
    const reader = new ArchiveReader(this.archiveDir)
    const info = await reader.info().catch(() => undefined)
    if (!info) return empty
    try {
      const mark = await reader.mark()
      const key = JSON.stringify([info.apiOrigin, mark.runs, mark.coveredUntil, mark.locked])
      if (this.#cached?.key === key) return this.#cached.summary
      const tickets = await reader.tickets()
      const brands = new Map<string, { name: string; tickets: number }>()
      for (const record of await reader.collection("brands"))
        if (record.id !== undefined)
          brands.set(String(record.id), {
            name: typeof record.name === "string" ? record.name : String(record.id),
            tickets: 0,
          })
      const tags = new Map<string, number>()
      let live = 0
      for (const record of tickets.values()) {
        if (record.status === "deleted") continue
        live++
        const brandId = record.brand_id === null || record.brand_id === undefined ? "" : String(record.brand_id)
        if (BRAND_ID.test(brandId)) {
          const brand = brands.get(brandId) ?? { name: brandId, tickets: 0 }
          brand.tickets++
          brands.set(brandId, brand)
        }
        for (const tag of Array.isArray(record.tags) ? new Set(record.tags) : [])
          if (typeof tag === "string" && tag.length <= TAG_MAX) tags.set(tag, (tags.get(tag) ?? 0) + 1)
      }
      const summary: ArchiveSummary = {
        archive: {
          present: true,
          origin: info.apiOrigin,
          runs: mark.runs,
          coveredUntil: mark.coveredUntil,
          backupRunning: mark.locked,
          tickets: live,
        },
        brands,
        tags,
      }
      this.#cached = { key, summary }
      return summary
    } catch (error) {
      log.warn("the Zendesk archive could not be read", { error: (error as Error).name })
      return empty
    }
  }

  async view(): Promise<ImportView> {
    const window = await importWindow(this.db)
    const [config] = await this.db.select().from(zendeskImport).where(eq(zendeskImport.id, 1))
    const summary = await this.#summary()
    const origin = config?.origin ?? null
    const brandMap = new Map((await this.db.select().from(zendeskBrandMap)).map((row) => [row.brandId, row]))
    const tagMap = new Map((await this.db.select().from(zendeskTagMap)).map((row) => [row.tag, row]))
    const users = await this.db
      .select({ id: authUser.id, name: authUser.name, username: authUser.username })
      .from(authUser)
      .where(and(inArray(authUser.role, ["admin", "agent"]), or(isNull(authUser.banned), eq(authUser.banned, false))))
      .orderBy(asc(sql`lower(coalesce(nullif(${authUser.name}, ''), ${authUser.username}))`))
    const [run] = await this.db.select().from(importRun).orderBy(desc(importRun.createdAt)).limit(1)
    return {
      window: { open: window.open, finishedAt: window.finishedAt?.toISOString() ?? null },
      archive: {
        ...summary.archive,
        otherOrigin: summary.archive.present && origin !== null && origin !== summary.archive.origin,
      },
      brands: [...new Set([...summary.brands.keys(), ...brandMap.keys()])]
        .map((id) => ({
          id,
          name: summary.brands.get(id)?.name ?? id,
          tickets: summary.brands.get(id)?.tickets ?? 0,
          organizationId: brandMap.get(id)?.organizationId ?? null,
        }))
        .sort((a, b) => b.tickets - a.tickets || a.name.localeCompare(b.name)),
      tags: [...new Set([...summary.tags.keys(), ...tagMap.keys()])]
        .map((tag) => ({ tag, tickets: summary.tags.get(tag) ?? 0, categoryId: tagMap.get(tag)?.categoryId ?? null }))
        .sort((a, b) => b.tickets - a.tickets || a.tag.localeCompare(b.tag)),
      agentUserId: config?.agentUserId ?? null,
      users: users.map((user) => ({ id: user.id, name: user.name || user.username || user.id })),
      organizations: await this.db
        .select({ id: organization.id, name: organization.name })
        .from(organization)
        .orderBy(asc(sql`lower(${organization.name})`)),
      categories: await this.db
        .select({ id: category.id, name: category.name })
        .from(category)
        .orderBy(asc(sql`lower(${category.name})`)),
      run: run ? await this.#runView(run) : null,
    }
  }

  async latest(): Promise<ImportRunView | null> {
    const [run] = await this.db.select().from(importRun).orderBy(desc(importRun.createdAt)).limit(1)
    return run ? this.#runView(run) : null
  }

  async #runView(run: RunRow): Promise<ImportRunView> {
    const job = run.state === "running" ? await this.jobs.pending(ZENDESK_IMPORT, { runId: run.id }) : null
    const [rows] = await this.db.select({ n: count() }).from(importReport).where(eq(importReport.runId, run.id))
    return {
      id: run.id,
      state: run.state as ImportRunState,
      reason: run.reason as ImportStopReason | null,
      problems: Array.isArray(run.problems) ? run.problems.filter((p): p is string => typeof p === "string") : [],
      failure: run.state === "running" ? failureView(run.failure) : null,
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      coveredUntil: run.coveredUntil?.toISOString() ?? null,
      highestNumber: run.highestNumber,
      total: run.total,
      done: run.done,
      counts: { ...emptyImportCounts(), ...((run.counts ?? {}) as Partial<ImportCounts>) },
      reportRows: rows?.n ?? 0,
      jobActive: job !== null,
      retrying: job === "retry",
    }
  }

  async saveMapping(input: ImportMappingInput, acting: Acting): Promise<void> {
    const brands = Object.entries(input.brands)
    const tags = Object.entries(input.tags)
    if (brands.some(([id, org]) => !BRAND_ID.test(id) || (org !== null && !UUID.test(org))))
      throw new Refusal("request_invalid", 400)
    if (tags.some(([tag, cat]) => tag === "" || tag.length > TAG_MAX || (cat !== null && !UUID.test(cat))))
      throw new Refusal("request_invalid", 400)
    await this.db.transaction(async (tx) => {
      const window = await importWindow(tx, "update")
      if (!window.open) throw new Refusal("import_closed", 409)
      const [open] = await tx.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running"))
      if (open) throw new Refusal("import_running", 409)
      const organizations = brands.flatMap(([, org]) => (org ? [org] : []))
      const categories = tags.flatMap(([, cat]) => (cat ? [cat] : []))
      const foundOrganizations = organizations.length
        ? await tx.select({ id: organization.id }).from(organization).where(inArray(organization.id, organizations))
        : []
      if (new Set(foundOrganizations.map((row) => row.id)).size !== new Set(organizations).size)
        throw new Refusal("organization_not_found", 404)
      const foundCategories = categories.length
        ? await tx.select({ id: category.id }).from(category).where(inArray(category.id, categories)).for("share")
        : []
      if (new Set(foundCategories.map((row) => row.id)).size !== new Set(categories).size)
        throw new Refusal("category_not_found", 404)
      if (input.agentUserId !== null) {
        const [user] = await tx
          .select({ role: authUser.role, banned: authUser.banned })
          .from(authUser)
          .where(eq(authUser.id, input.agentUserId))
        if (!user || user.banned || (user.role !== "admin" && user.role !== "agent"))
          throw new Refusal("import_user_invalid", 400)
      }
      await tx.delete(zendeskBrandMap)
      const brandRows = brands.flatMap(([brandId, org]) => (org ? [{ brandId, organizationId: org }] : []))
      if (brandRows.length) await tx.insert(zendeskBrandMap).values(brandRows)
      await tx.delete(zendeskTagMap)
      const tagRows = tags.flatMap(([tag, cat]) => (cat ? [{ tag, categoryId: cat }] : []))
      if (tagRows.length) await tx.insert(zendeskTagMap).values(tagRows)
      await tx
        .update(zendeskImport)
        .set({ agentUserId: input.agentUserId, updatedAt: new Date() })
        .where(eq(zendeskImport.id, 1))
      await writeAudit(tx, acting.actor, {
        action: "import.mapping",
        entityType: "zendesk_import",
        entityId: "1",
        details: { brands: brandRows.length, tags: tagRows.length, agentUserId: input.agentUserId },
        ipAddress: acting.ipAddress,
      })
    })
  }

  async start(userId: string): Promise<ImportRunView> {
    const runId = await transactionWithJobs(this.db, async (tx, jobs) => {
      const window = await importWindow(tx, "update")
      if (!window.open) throw new Refusal("import_closed", 409)
      const [config] = await tx.select().from(zendeskImport).where(eq(zendeskImport.id, 1))
      if (!config?.agentUserId) throw new Refusal("import_no_agent", 409)
      const [open] = await tx.select({ id: importRun.id }).from(importRun).where(eq(importRun.state, "running"))
      if (open) {
        await this.jobs.sendIn(jobs, ZENDESK_IMPORT, { runId: open.id }, HEARTBEAT)
        return open.id
      }
      const [made] = await tx.insert(importRun).values({ startedBy: userId }).returning({ id: importRun.id })
      if (!made) throw new Error("the run was not written")
      await this.jobs.sendIn(jobs, ZENDESK_IMPORT, { runId: made.id }, HEARTBEAT)
      return made.id
    })
    const [run] = await this.db.select().from(importRun).where(eq(importRun.id, runId))
    if (!run) throw new Error("the run was not found")
    return this.#runView(run)
  }

  async cancel(runId: string, acting: Acting): Promise<{ run: ImportRunView | null; cancelled: boolean }> {
    if (!UUID.test(runId)) throw new Refusal("request_invalid", 400)
    const cancelled = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(importRun)
        .set({ state: "stopped", reason: "cancelled", failure: null, finishedAt: sql`now()` })
        .where(and(eq(importRun.id, runId), eq(importRun.state, "running")))
        .returning()
      if (!run) return false
      await writeAudit(tx, acting.actor, {
        action: "import.cancel",
        entityType: "import_run",
        entityId: run.id,
        details: { tickets: run.done, total: run.total, counts: run.counts },
        ipAddress: acting.ipAddress,
      })
      return true
    })
    return { run: await this.latest(), cancelled }
  }

  async finish(acting: Acting): Promise<void> {
    await this.db.transaction(async (tx) => {
      if (!(await finishImport(tx))) return
      await writeAudit(tx, acting.actor, {
        action: "import.finish",
        entityType: "zendesk_import",
        entityId: "1",
        details: {},
        ipAddress: acting.ipAddress,
      })
    })
  }

  async report(runId: string, after: string | undefined): Promise<ImportReportPage> {
    if (!UUID.test(runId)) throw new Refusal("not_found", 404)
    const cursor = after === undefined ? 0 : Number(after)
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Refusal("request_invalid", 400)
    const rows = await this.db
      .select()
      .from(importReport)
      .where(and(eq(importReport.runId, runId), gt(importReport.id, cursor)))
      .orderBy(asc(importReport.id))
      .limit(IMPORT_REPORT_PAGE_SIZE)
    const last = rows.at(-1)
    return {
      rows: rows.map((row) => ({
        id: row.id,
        zendeskId: row.zendeskId,
        reason: row.reason as ImportReportReason,
        detail: row.detail,
      })),
      next: rows.length === IMPORT_REPORT_PAGE_SIZE && last ? String(last.id) : null,
    }
  }
}
