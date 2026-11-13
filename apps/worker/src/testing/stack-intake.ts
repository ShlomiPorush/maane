import { randomBytes } from "node:crypto"
import { stat } from "node:fs/promises"
import { SYSTEM } from "@maane/server/audit"
import { loadConfig } from "@maane/server/config"
import { openDatabase } from "@maane/server/db/client"
import {
  intakeRecord,
  message,
  messagePart,
  organization,
  storedFile,
  supportAddress,
  ticket,
} from "@maane/server/db/schema"
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
// Printed by Chromium with IBM Plex Mono (SIL Open Font License) embedded as a TrueType subset: a PDF whose font pdf.js
// loads itself.
import embeddedFontPdf from "./embedded-font.pdf"
import { startStandInGraph } from "./graph.ts"
import { encodedWord, INVOICE, mime, SHALOM_OLAM } from "./mime.ts"

// Intake end to end in the container stack (scripts/verify.sh, before the end-to-end tests): run in a container of the
// worker service, with its configuration, network, read-only root, and /data, against the stack's PostgreSQL and the
// real ClamAV, and a stand-in Graph inside this process (its certificate trusted only here). The Graph settings are
// given to this process alone, as variables would: the stack's own worker has none, so its schedule stays a quiet no-op
// and never reaches Microsoft. Messages become tickets in live mode and intake records in listening mode, and those
// tickets are the ones the end-to-end tests read (e2e/tickets.spec.ts names them by their subjects and organizations;
// keep both in step). At the end the stand-in's source stops being current, the intake mode is listening again, and
// the default address this check set is unset. Bundled by verify.sh into apps/worker/dist/stack-check; never part of
// the image.

let failed = false
const check = (ok: boolean, what: string) => {
  console.log(`    ${ok ? "ok" : "FAIL"}: ${what}`)
  if (!ok) failed = true
}

/** What the end-to-end tests find: two organizations, their addresses, and the subjects of their tickets. */
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
  // Live needs a default address. None exists before the end-to-end tests: Alpha's address is it for this run.
  const [fallback] = await db.select().from(supportAddress).where(eq(supportAddress.isDefault, true))
  if (!fallback) {
    await db.update(supportAddress).set({ isDefault: true }).where(eq(supportAddress.value, alpha.address))
    setDefault = true
  }
  await settings.update({ "intake.mode": "live" }, SYSTEM)

  // A Hebrew message written without dir, with an inline image, a remote image, a Hebrew-named PDF, and a photo.
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
          // A link the end-to-end tests open from the frame: the stack's own public address (verify.sh).
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
  // An English text-only message with a text file; later, a reply to it while listening.
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
  // An infected attachment beside a drawing (markup: download only).
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
  // A text body the scanner blocks, beside an HTML version it does not.
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
  // Scans and faxes (JBIG2, CCITT), and a PDF with an embedded font.
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

  // Text fields are scanned like files (review G1): EICAR as a whole text body is blocked by the real ClamAV. Inside
  // the header block it follows other values; what the real scanner does with that is reported, not required.
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

  await settings.update({ "intake.mode": "listening" }, SYSTEM)
  const listeningId = graph.add(mime({ to: alpha.address, subject: `Listening ${run}` }))
  const replyId = graph.add(
    mime({
      to: alpha.address,
      subject: `Re: ${FIXTURES.english}`,
      inReplyTo: englishMessageId,
      references: [englishMessageId],
      text: { content: "One more detail about the invoice." },
    }),
  )
  await round()
  const listening = await stored(listeningId)
  const [record] = listening ? await db.select().from(intakeRecord).where(eq(intakeRecord.messageId, listening.id)) : []
  check(
    record?.mode === "listening" &&
      record.outcome === "new_ticket" &&
      record.ticketId === null &&
      record.supportAddress === alpha.address &&
      listening?.ticketId === null,
    `listening: an intake record (${record?.outcome ?? "none"}) and no ticket`,
  )
  const reply = await stored(replyId)
  const [heard] = reply ? await db.select().from(intakeRecord).where(eq(intakeRecord.messageId, reply.id)) : []
  check(
    heard?.outcome === "joined" && heard.matchedTicketId === opened?.id && reply?.ticketId === null,
    `listening: a reply would join ticket #${opened?.number ?? "none"} (${heard?.outcome ?? "none"}), which stays as it is`,
  )
  check(graph.withoutImmutableIds.length === 0, "every Graph request asked for immutable IDs")
} catch (error) {
  check(false, `the intake check threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  // The stack's own settings again: no current source (it has no Graph settings), listening, and no default address
  // of this check's, so the end-to-end tests set their own.
  await reconcileIntakeSource(db, stackSettings).catch(() => undefined)
  await stackSettings.update({ "intake.mode": "listening" }, SYSTEM).catch(() => undefined)
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
