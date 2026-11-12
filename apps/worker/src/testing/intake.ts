import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import {
  intakeRecord,
  message,
  messagePart,
  organization,
  supportAddress,
  ticket,
  ticketLink,
  ticketParticipant,
} from "@maane/server/db/schema"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { createTestDatabase, testKey } from "@maane/server/testing/db"
import { type IntakeMode, MEGABYTE, type SettingKey } from "@maane/shared"
import { asc, eq } from "drizzle-orm"
import { clamdScanner, type Scanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { GraphGateway } from "../intake/graph.ts"
import { IntakeProcessor } from "../intake/process.ts"
import { WaitingFiles } from "../intake/retry.ts"
import { IntakeSync } from "../intake/sync.ts"
import type { StandInClamd } from "./clamd.ts"
import { type StandInGraph, startStandInGraph } from "./graph.ts"

// The pieces of intake wired together for one integration test: a migrated database of its own, a file store in a
// temporary directory, a stand-in Graph with a secret new for the test, the shared stand-in clamd, and the settings
// that point at both (which make the stand-in's mailbox the current intake source).

export interface IntakeHarness {
  database: Awaited<ReturnType<typeof createTestDatabase>>
  graph: StandInGraph
  settings: Settings
  cipherKey: string
  files: FileService
  gateway: GraphGateway
  sync: IntakeSync
  processor: IntakeProcessor
  retry: WaitingFiles
  dir: string
  /** A new organization with its addresses; returns its ID. */
  organization(
    name: string,
    addresses: { value: string; kind?: "exact" | "pattern"; isDefault?: boolean }[],
  ): Promise<string>
  mode(mode: IntakeMode): Promise<void>
  /** Stage one, then stage two. */
  round(): Promise<void>
  messageOf(graphId: string): Promise<typeof message.$inferSelect>
  partsOf(graphId: string): Promise<(typeof messagePart.$inferSelect)[]>
  recordOf(graphId: string): Promise<typeof intakeRecord.$inferSelect | undefined>
  ticketOf(graphId: string): Promise<typeof ticket.$inferSelect | undefined>
  participantsOf(ticketId: string): Promise<string[]>
  linksOf(ticketId: string): Promise<{ linkedTicketId: string; reason: string }[]>
  tickets(): Promise<(typeof ticket.$inferSelect)[]>
  close(): Promise<void>
}

export async function startIntake(
  clamd: StandInClamd,
  overrides: Partial<Record<SettingKey, string>> = {},
  options: { scanner?: Scanner } = {},
) {
  const database = await createTestDatabase()
  const graph = await startStandInGraph()
  const dir = join(await mkdtemp(join(tmpdir(), "maane-intake-")), "files")
  const store = new FileStore(dir)
  await store.prepare()
  const cipherKey = testKey()
  const settings = new Settings(database.db, createSettingsCipher([{ version: 1, value: cipherKey }]), overrides)
  const config = graph.config()
  const changes: Record<string, unknown> = {
    "scanner.address": clamd.address,
    "scanner.unavailablePolicy": "block",
    "files.maxBytes": 5 * MEGABYTE,
  }
  for (const [key, value] of [
    ["graph.tenantId", config.tenantId],
    ["graph.clientId", config.clientId],
    ["graph.clientSecret", config.clientSecret],
    ["graph.mailbox", config.mailbox],
  ] as const)
    if (overrides[key] === undefined) changes[key] = value
  await settings.update(changes, SYSTEM)
  const files = new FileService({ db: database.db, settings, scanner: options.scanner ?? clamdScanner, store })
  const gateway = new GraphGateway(graph.endpoints)
  const sync = new IntakeSync({ db: database.db, settings, files, graph: gateway })
  const processor = new IntakeProcessor({ db: database.db })
  const retry = new WaitingFiles({ db: database.db, settings, files, graph: gateway })
  const db = database.db
  const messageOf = async (graphId: string) => {
    const [row] = await db.select().from(message).where(eq(message.graphId, graphId))
    if (!row) throw new Error(`no stored message ${graphId}`)
    return row
  }
  const harness: IntakeHarness = {
    database,
    graph,
    settings,
    cipherKey,
    files,
    gateway,
    sync,
    processor,
    retry,
    dir,
    async organization(name, addresses) {
      const [made] = await db.insert(organization).values({ name }).returning({ id: organization.id })
      if (!made) throw new Error("no organization")
      for (const address of addresses)
        await db.insert(supportAddress).values({
          organizationId: made.id,
          kind: address.kind ?? "exact",
          value: address.value,
          isDefault: address.isDefault ?? false,
        })
      return made.id
    },
    mode: (mode) => settings.update({ "intake.mode": mode }, SYSTEM),
    async round() {
      await sync.run()
      await processor.run()
    },
    messageOf,
    async partsOf(graphId) {
      const row = await messageOf(graphId)
      return db.select().from(messagePart).where(eq(messagePart.messageId, row.id)).orderBy(asc(messagePart.index))
    },
    async recordOf(graphId) {
      const row = await messageOf(graphId)
      return (await db.select().from(intakeRecord).where(eq(intakeRecord.messageId, row.id)))[0]
    },
    async ticketOf(graphId) {
      const row = await messageOf(graphId)
      if (!row.ticketId) return undefined
      return (await db.select().from(ticket).where(eq(ticket.id, row.ticketId)))[0]
    },
    async participantsOf(ticketId) {
      const rows = await db
        .select({ address: ticketParticipant.address })
        .from(ticketParticipant)
        .where(eq(ticketParticipant.ticketId, ticketId))
      return rows.map((row) => row.address).sort()
    },
    async linksOf(ticketId) {
      return db
        .select({ linkedTicketId: ticketLink.linkedTicketId, reason: ticketLink.reason })
        .from(ticketLink)
        .where(eq(ticketLink.ticketId, ticketId))
    },
    tickets: () => db.select().from(ticket).orderBy(asc(ticket.number)),
    async close() {
      await graph.close()
      await database.drop()
      await rm(join(dir, ".."), { recursive: true, force: true })
    },
  }
  return harness
}
