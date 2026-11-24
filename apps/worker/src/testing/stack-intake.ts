import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import { message, messagePart, organization, storedFile, supportAddress, ticket } from "@maane/server/db/schema"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { pdf, png, scannedPdf } from "@maane/server/testing/files"
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
import embeddedFontPdf from "./embedded-font.pdf"
import { startStandInGraph } from "./graph.ts"
import { encodedWord, INVOICE, mime, SHALOM_OLAM } from "./mime.ts"

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`    ${ok ? "ok" : "FAIL"}: ${what}`)
  if (!ok) failed = true
}

export const FIXTURES = {
  alpha: { name: "Example Alpha", address: "alpha@example.com" },
  beta: { name: "Example Beta", address: "beta@example.com" },
  hebrewSubject: `${SHALOM_OLAM} - ${INVOICE}`,
  english: "Question about the invoice",
  blockedFile: "Blocked attachment",
  blockedText: "Blocked text",
  betaSubject: "Question for Beta",
  scanned: "Scanned documents",
} as const

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
const { alpha, beta } = FIXTURES
let setDefault = false

const round = async () => {
  const summary = await sync.run()
  await processor.run()
  return summary
}
const stored = async (graphId: string) => (await db.select().from(message).where(eq(message.graphId, graphId)))[0]
const partsOf = async (row: Awaited<ReturnType<typeof stored>>) =>
  row
    ? await db
        .select({ part: messagePart, detectedType: storedFile.detectedType })
        .from(messagePart)
        .leftJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
        .where(eq(messagePart.messageId, row.id))
        .orderBy(asc(messagePart.index))
    : []
const onDisk = (sha256: string | null) =>
  sha256
    ? stat(files.storedPath(sha256)).then(
        () => true,
        () => false,
      )
    : Promise.resolve(false)

try {
  await reconcileIntakeSource(db, settings)
  const organizations: Record<string, string> = {}
  for (const { name, address } of [alpha, beta]) {
    const [made] = await db.insert(organization).values({ name }).returning({ id: organization.id })
    organizations[address] = made?.id ?? ""
    await db.insert(supportAddress).values({ organizationId: made?.id ?? "", kind: "exact", value: address })
  }
  const alphaId = organizations[alpha.address] ?? ""
  const [fallback] = await db.select().from(supportAddress).where(eq(supportAddress.isDefault, true))
  if (!fallback) {
    await db.update(supportAddress).set({ isDefault: true }).where(eq(supportAddress.value, alpha.address))
    setDefault = true
  }

  const hebrewId = graph.add(
    mime({
      to: alpha.address,
      subject: encodedWord(FIXTURES.hebrewSubject),
      html: {
        content:
          `<p>${SHALOM_OLAM},</p><p>${INVOICE} 2026-117 (PDF).</p>` +
          '<p><img src="cid:logo@example.com" alt="logo"></p>' +
          '<p><img src="https://images.example.com/banner.png" alt="banner" width="320" height="80"></p>' +
          '<p align="center">Example Alpha</p>' +
          "<p>Order 2026-117 is attached in English too.</p>" +
          '<p><a href="http://127.0.0.1:8095/healthz/live">Service status</a> <a href="tel:+15555550100">Call us</a></p>',
      },
      attachments: [
        {
          fileName: "logo.png",
          contentType: "image/png",
          content: png(96, 40),
          inline: true,
          contentId: "logo@example.com",
        },
        { fileName: `${INVOICE}.pdf`, contentType: "application/pdf", content: pdf("Invoice 2026-117") },
        { fileName: "photo.png", contentType: "image/png", content: png(320, 200, [18, 128, 63]) },
      ],
    }),
  )
  const englishMessageId = `english-${run}@mail.example.com`
  const clean = Buffer.from(`Maane stack intake ${run}\nLine two of the notes.\n`, "utf8")
  const englishId = graph.add(
    mime({
      messageId: englishMessageId,
      to: alpha.address,
      subject: FIXTURES.english,
      text: { content: "Hello,\n\nThe invoice I received shows the wrong amount.\nCan you check it?\n\nThanks,\nDana" },
      attachments: [{ fileName: "notes.txt", contentType: "text/plain", content: clean }],
    }),
  )
  const infectedId = graph.add(
    mime({
      to: alpha.address,
      subject: FIXTURES.blockedFile,
      text: { content: "Please see the two attached files." },
      attachments: [
        { fileName: "readme.txt", contentType: "text/plain", content: eicar() },
        {
          fileName: "drawing.svg",
          contentType: "image/svg+xml",
          content: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', "utf8"),
        },
      ],
    }),
  )
  const blockedTextId = graph.add(
    mime({
      to: alpha.address,
      subject: FIXTURES.blockedText,
      text: { content: eicar().toString("latin1") },
      html: { content: "<p>The formatted version of this message is fine.</p>" },
    }),
  )
  const betaId = graph.add(
    mime({
      to: beta.address,
      subject: FIXTURES.betaSubject,
      text: { content: "A question that only Beta's agents see." },
    }),
  )
  const automatedId = graph.add(
    mime({
      to: alpha.address,
      subject: "Out of office",
      headers: [["Auto-Submitted", "auto-replied"]],
      text: { content: "I am away this week." },
    }),
  )
  const scannedId = graph.add(
    mime({
      to: alpha.address,
      subject: FIXTURES.scanned,
      text: { content: "The signed pages, scanned." },
      attachments: [
        { fileName: "scan-jbig2.pdf", contentType: "application/pdf", content: scannedPdf("jbig2") },
        { fileName: "fax-ccitt.pdf", contentType: "application/pdf", content: scannedPdf("ccitt") },
        { fileName: "embedded-font.pdf", contentType: "application/pdf", content: Buffer.from(embeddedFontPdf) },
      ],
    }),
  )
  const first = await round()
  check(
    first.status === "done" && first.stored === 7,
    `stage one stored ${first.stored} of 7 messages (${first.status})`,
  )

  const live = await stored(englishId)
  const [opened] = live?.ticketId ? await db.select().from(ticket).where(eq(ticket.id, live.ticketId)) : []
  check(
    opened?.organizationId === alphaId &&
      opened.supportAddress === alpha.address &&
      REFERENCE_CODE.test(opened.referenceCode) &&
      opened.number > 0,
    `live: the message opened ticket #${opened?.number ?? "none"} for ${opened?.supportAddress ?? "no address"}`,
  )
  const [notes] = await partsOf(live)
  check(
    notes?.part.status === "clean" && (await onDisk(notes.part.storedSha256)),
    `live: its attachment scanned ${notes?.part.status ?? "missing"} and is stored`,
  )
  check(Boolean(live?.rawSha256), "live: the raw MIME is kept (it and every part scanned clean)")

  const hebrew = await stored(hebrewId)
  const hebrewParts = await partsOf(hebrew)
  check(
    hebrew?.ticketId !== null &&
      hebrewParts.length === 3 &&
      hebrewParts.every(({ part }) => part.status === "clean") &&
      hebrewParts.map(({ detectedType }) => detectedType).join() === "image/png,application/pdf,image/png",
    `Hebrew: a ticket, and its inline image, PDF, and photo scanned ${hebrewParts.map(({ part }) => part.status).join(", ")}`,
  )

  const infected = await stored(infectedId)
  const [bad, drawing] = await partsOf(infected)
  check(
    bad?.part.status === "infected" && bad.part.storedSha256 === null && infected?.rawSha256 === null,
    `an EICAR attachment: ${bad?.part.status ?? "missing"} ${bad?.part.signature ?? ""}, raw MIME not kept`.trim(),
  )
  check(
    drawing?.part.status === "clean" && drawing.detectedType === "application/octet-stream",
    `an SVG drawing: ${drawing?.part.status ?? "missing"}, read as ${drawing?.detectedType ?? "nothing"} (download only)`,
  )

  const scanOf = (row: Awaited<ReturnType<typeof stored>>, field: string) =>
    (row?.fieldScans as Record<string, { status: string; signature: string | null }> | undefined)?.[field]
  const textRow = await stored(blockedTextId)
  check(
    textRow?.textBody === null && scanOf(textRow, "text")?.status === "infected" && Boolean(textRow.htmlBody),
    `EICAR as the text body: ${scanOf(textRow, "text")?.status ?? "no scan"} ${scanOf(textRow, "text")?.signature ?? ""}, not stored; the HTML is`.trim(),
  )
  const subjectId = graph.add(mime({ to: alpha.address, subject: eicar().toString("latin1") }))
  await round()
  const subjectRow = await stored(subjectId)
  console.log(
    `    info: EICAR as the subject, inside the header block: ${scanOf(subjectRow, "headers")?.status ?? "no scan"}` +
      ` (subject stored: ${subjectRow?.subject === null ? "no" : "yes"})`,
  )

  const scannedParts = await partsOf(await stored(scannedId))
  check(
    scannedParts.length === 3 &&
      scannedParts.every(({ part, detectedType }) => part.status === "clean" && detectedType === "application/pdf"),
    `scanned PDFs: ${scannedParts.map(({ part, detectedType }) => `${part.status} ${detectedType}`).join(", ")}`,
  )

  const betaRow = await stored(betaId)
  const [betaTicket] = betaRow?.ticketId ? await db.select().from(ticket).where(eq(ticket.id, betaRow.ticketId)) : []
  check(betaTicket?.organizationId === organizations[beta.address], "Beta: its own ticket in its own organization")
  const automated = await stored(automatedId)
  check(automated?.ticketId === null && automated.classification === "automated", "automated mail opens no ticket")

  check(graph.withoutImmutableIds.length === 0, "every Graph request asked for immutable IDs")
} catch (error) {
  check(false, `the intake check threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await reconcileIntakeSource(db, stackSettings).catch(() => undefined)
  if (setDefault)
    await db
      .update(supportAddress)
      .set({ isDefault: false })
      .where(eq(supportAddress.value, alpha.address))
      .catch(() => undefined)
  await graph.close()
  await database.close()
}
process.exit(failed ? 1 : 0)
