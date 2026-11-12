import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import { SYSTEM } from "@maane/server/audit"
import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { intakeRecord, message, messagePart, organization, supportAddress, ticket } from "@maane/server/db/schema"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { REFERENCE_CODE } from "@maane/shared"
import { asc, eq } from "drizzle-orm"
import { eicar } from "../files/samples.ts"
import { clamdScanner } from "../files/scanner.ts"
import { FileService } from "../files/service.ts"
import { FileStore } from "../files/store.ts"
import { GraphGateway } from "../intake/graph.ts"
import { reconcileIntakeSource } from "../intake/jobs.ts"
import { IntakeProcessor } from "../intake/process.ts"
import { IntakeSync } from "../intake/sync.ts"
import { startStandInGraph } from "./graph.ts"
import { mime } from "./mime.ts"

// Intake end to end in the container stack (scripts/verify.sh, after the end-to-end tests): run in a container of the
// worker service, with its configuration, network, read-only root, and /data, against the stack's PostgreSQL and the
// real ClamAV, and a stand-in Graph inside this process (its certificate trusted only here). The Graph settings are
// given to this process alone, as variables would: the stack's own worker has none, so its schedule stays a quiet no-op
// and never reaches Microsoft. A message becomes a ticket in live mode and an intake record in listening mode. At the
// end the stand-in's source stops being current and the intake mode is listening again. Bundled by verify.sh into
// apps/worker/dist/stack-check; never part of the image.

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`    ${ok ? "ok" : "FAIL"}: ${what}`)
  if (!ok) failed = true
}

const config = loadConfig()
const database = openDatabase(config.databaseUrl, 3)
const db = database.db
const cipher = createSettingsCipher(config.settingsKeys)
const graph = await startStandInGraph()
const settings = new Settings(db, cipher, {
  ...config.overrides,
  "graph.tenantId": graph.tenantId,
  "graph.clientId": graph.clientId,
  "graph.clientSecret": graph.clientSecret,
  "graph.mailbox": graph.mailbox,
})
const stackSettings = new Settings(db, cipher, config.overrides)
const files = new FileService({ db, settings, scanner: clamdScanner, store: new FileStore(config.filesDir) })
const gateway = new GraphGateway(graph.endpoints)
const sync = new IntakeSync({ db, settings, files, graph: gateway })
const processor = new IntakeProcessor({ db })
const run = randomBytes(4).toString("hex")
const address = `stack-${run}@example.com`

const round = async () => {
  const summary = await sync.run()
  await processor.run()
  return summary
}
const stored = async (graphId: string) => (await db.select().from(message).where(eq(message.graphId, graphId)))[0]

try {
  await reconcileIntakeSource(db, settings)
  const [made] = await db
    .insert(organization)
    .values({ name: `Stack check ${run}` })
    .returning({ id: organization.id })
  const organizationId = made?.id ?? ""
  await db.insert(supportAddress).values({ organizationId, kind: "exact", value: address })
  // Live needs a default address; the end-to-end tests made one. Without one, this run's address becomes it.
  const [fallback] = await db.select().from(supportAddress).where(eq(supportAddress.isDefault, true))
  if (!fallback) await db.update(supportAddress).set({ isDefault: true }).where(eq(supportAddress.value, address))
  await settings.update({ "intake.mode": "live" }, SYSTEM)

  const clean = Buffer.from(`Maane stack intake ${run}\n`, "utf8")
  const liveId = graph.add(
    mime({
      to: address,
      subject: `Live ${run}`,
      attachments: [{ fileName: "notes.txt", contentType: "text/plain", content: clean }],
    }),
  )
  const infectedId = graph.add(
    mime({
      to: address,
      subject: `Infected ${run}`,
      attachments: [{ fileName: "readme.txt", contentType: "text/plain", content: eicar() }],
    }),
  )
  const first = await round()
  check(
    first.status === "done" && first.stored === 2,
    `stage one stored ${first.stored} of 2 messages (${first.status})`,
  )

  const live = await stored(liveId)
  const [opened] = live?.ticketId ? await db.select().from(ticket).where(eq(ticket.id, live.ticketId)) : []
  check(
    opened?.organizationId === organizationId &&
      opened.supportAddress === address &&
      REFERENCE_CODE.test(opened.referenceCode) &&
      opened.number > 0,
    `live: the message opened ticket #${opened?.number ?? "none"} for ${opened?.supportAddress ?? "no address"}`,
  )
  const [part] = live ? await db.select().from(messagePart).where(eq(messagePart.messageId, live.id)) : []
  const onDisk = part?.storedSha256
    ? await stat(files.storedPath(part.storedSha256)).then(
        () => true,
        () => false,
      )
    : false
  check(part?.status === "clean" && onDisk, `live: its attachment scanned ${part?.status ?? "missing"} and is stored`)
  check(Boolean(live?.rawSha256), "live: the raw MIME is kept (it and every part scanned clean)")

  const infected = await stored(infectedId)
  const [bad] = infected
    ? await db.select().from(messagePart).where(eq(messagePart.messageId, infected.id)).orderBy(asc(messagePart.index))
    : []
  check(
    bad?.status === "infected" && bad.storedSha256 === null && infected?.rawSha256 === null,
    `an EICAR attachment: ${bad?.status ?? "missing"} ${bad?.signature ?? ""}, raw MIME not kept`.trim(),
  )

  // Text fields are scanned like files (review G1): EICAR as a whole text body is blocked by the real ClamAV. Inside
  // the header block it follows other values; what the real scanner does with that is reported, not required.
  const textId = graph.add(mime({ to: address, subject: `Text ${run}`, text: { content: eicar().toString("latin1") } }))
  const subjectId = graph.add(mime({ to: address, subject: eicar().toString("latin1") }))
  await round()
  const scanOf = (row: Awaited<ReturnType<typeof stored>>, field: string) =>
    (row?.fieldScans as Record<string, { status: string; signature: string | null }> | undefined)?.[field]
  const textRow = await stored(textId)
  check(
    textRow?.textBody === null && scanOf(textRow, "text")?.status === "infected",
    `EICAR as the text body: ${scanOf(textRow, "text")?.status ?? "no scan"} ${scanOf(textRow, "text")?.signature ?? ""}, not stored`.trim(),
  )
  const subjectRow = await stored(subjectId)
  console.log(
    `    info: EICAR as the subject, inside the header block: ${scanOf(subjectRow, "headers")?.status ?? "no scan"}` +
      ` (subject stored: ${subjectRow?.subject === null ? "no" : "yes"})`,
  )

  await settings.update({ "intake.mode": "listening" }, SYSTEM)
  const listeningId = graph.add(mime({ to: address, subject: `Listening ${run}` }))
  await round()
  const listening = await stored(listeningId)
  const [record] = listening ? await db.select().from(intakeRecord).where(eq(intakeRecord.messageId, listening.id)) : []
  check(
    record?.mode === "listening" &&
      record.outcome === "new_ticket" &&
      record.ticketId === null &&
      record.supportAddress === address &&
      listening?.ticketId === null,
    `listening: an intake record (${record?.outcome ?? "none"}) and no ticket`,
  )
  check(graph.withoutImmutableIds.length === 0, "every Graph request asked for immutable IDs")
} catch (error) {
  check(false, `the intake check threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // The stack's own settings again: no current source (it has no Graph settings), and listening.
  await reconcileIntakeSource(db, stackSettings).catch(() => undefined)
  await stackSettings.update({ "intake.mode": "listening" }, SYSTEM).catch(() => undefined)
  await graph.close()
  await database.close()
}
process.exit(failed ? 1 : 0)
