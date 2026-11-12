import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { SYSTEM } from "@maane/server/audit"
import { auditLog, intakeCursor, intakeSource, message, storedFile } from "@maane/server/db/schema"
import { createSettingsCipher } from "@maane/server/settings/crypto"
import { Settings } from "@maane/server/settings/service"
import { MEGABYTE } from "@maane/shared"
import { eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { eicar } from "../files/samples.ts"
import { sha256Of } from "../files/service.ts"
import { graphTest } from "../jobs.ts"
import { refusedAddress, type StandInClamd, startStandInClamd } from "../testing/clamd.ts"
import { type IntakeHarness, startIntake } from "../testing/intake.ts"
import { encodedWord, fromCodePoints, INVOICE, mime, SHALOM, SHALOM_OLAM } from "../testing/mime.ts"
import { GraphGateway } from "./graph.ts"
import { reconcileIntakeSource } from "./jobs.ts"
import { IntakeSync } from "./sync.ts"

let clamd: StandInClamd
let intake: IntakeHarness | null = null

beforeAll(async () => {
  clamd = await startStandInClamd()
})
afterAll(async () => {
  await clamd.close()
})
afterEach(async () => {
  await intake?.close()
  intake = null
})

const start = async (...args: Parameters<typeof startIntake> extends [unknown, ...infer R] ? R : never) => {
  intake = await startIntake(clamd, ...args)
  return intake
}

const cursorOf = async (h: IntakeHarness, folder = "inbox") =>
  (await h.database.db.select().from(intakeCursor).where(eq(intakeCursor.folder, folder)))[0]

const count = async (h: IntakeHarness) => (await h.database.db.select().from(message)).length

/** Every value of every row of the tables intake writes, as text. */
async function everythingStored(h: IntakeHarness): Promise<string> {
  const tables = ["message", "message_part", "intake_record", "ticket", "audit_log", "stored_file"]
  let all = ""
  for (const table of tables) {
    const result = await h.database.pool.query(`select coalesce(json_agg(t)::text, '') as rows from ${table} t`)
    all += result.rows[0].rows
  }
  return all
}

async function filesUnder(dir: string): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const shard of await readdir(dir)) {
    for (const name of await readdir(join(dir, shard)).catch(() => [] as string[]))
      out.push(await readFile(join(dir, shard, name)))
  }
  return out
}

describe("stage one: delta paging, the cursor, and vanished items", () => {
  it("stores every message once after a crash between a page's commit and its cursor, and moves the cursor only after", async () => {
    const h = await start()
    h.graph.pageSize = 2
    const ids = Array.from({ length: 5 }, (_, i) => h.graph.add(mime({ subject: `paging ${i}` })))
    // The worker "crashes" after the first page's messages are committed, before the page's link is stored.
    await expect(
      h.sync.run({
        afterMessages: async (folder, page) => {
          if (folder === "inbox" && page === 1) throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    expect(await count(h)).toBe(2)
    expect(await cursorOf(h)).toBeUndefined()
    // A crash after the first page's cursor: the next run goes on from the second page.
    await expect(
      h.sync.run({
        afterMessages: async (folder, page) => {
          if (folder === "inbox" && page === 2) throw new Error("crash")
        },
      }),
    ).rejects.toThrow("crash")
    expect(await cursorOf(h)).toMatchObject({ kind: "next" })
    expect(await count(h)).toBe(4)
    const before = h.graph.requests.length
    const summary = await h.sync.run()
    expect(summary).toMatchObject({ status: "done", stored: 1 })
    // It went on from the stored nextLink (page two again, whose messages are skipped), not from the start.
    const deltaRequests = h.graph.requests.slice(before).filter((line) => line.includes("/inbox/messages/delta"))
    expect(deltaRequests[0]).toContain("$skiptoken=")
    expect((await h.database.db.select().from(message)).map((row) => row.graphId).sort()).toEqual([...ids].sort())
    expect(await cursorOf(h)).toMatchObject({ kind: "delta" })
    expect(await cursorOf(h, "junkemail")).toMatchObject({ kind: "delta" })
    // Every Graph request asked for immutable IDs.
    expect(h.graph.withoutImmutableIds).toEqual([])
  })

  it("syncs a folder in full when its delta token expired, skipping what is stored", async () => {
    const h = await start()
    h.graph.add(mime())
    h.graph.add(mime(), { folder: "junkemail" })
    await h.sync.run()
    expect(await count(h)).toBe(2)
    const late = h.graph.add(mime({ subject: "after the token expired" }))
    h.graph.expireTokens()
    const before = h.graph.requests.length
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 1, skipped: 2 })
    expect(h.graph.requests.slice(before).some((line) => / 410|deltatoken/.test(line))).toBe(true)
    expect((await h.messageOf(late)).subject).toBe("after the token expired")
    expect(await count(h)).toBe(3)
  })

  it("skips @removed entries, keeps what it stored, and records a message that vanished before its content was read", async () => {
    const h = await start()
    const kept = h.graph.add(mime({ subject: "kept" }))
    await h.sync.run()
    // Deleted in the mailbox after Maane stored it: Maane keeps it.
    h.graph.remove(kept)
    // Added and deleted between two rounds: an @removed entry for a message never stored.
    const never = h.graph.add(mime({ subject: "never stored" }))
    h.graph.remove(never)
    // Listed by the delta query, gone by the time $value is read.
    const vanished = h.graph.add(mime({ messageId: "vanished@example.com", subject: "vanished" }))
    h.graph.vanish(vanished)
    const after = h.graph.add(mime({ subject: "after" }))
    const summary = await h.sync.run()
    expect(summary).toMatchObject({ status: "done", removed: 2 })
    expect((await h.messageOf(kept)).subject).toBe("kept")
    expect(await h.database.db.select().from(message).where(eq(message.graphId, never))).toEqual([])
    expect(await h.messageOf(vanished)).toMatchObject({
      content: "unavailable",
      reviewFlags: ["unavailable"],
      subject: "vanished",
      messageIdHeader: null,
      graph: expect.objectContaining({ internetMessageId: "<vanished@example.com>" }),
    })
    expect((await h.messageOf(after)).content).toBe("parsed")
    expect(await cursorOf(h)).toMatchObject({ kind: "delta" })
  })

  it("retries a throttled request after Retry-After, and keeps the cursor when Graph cannot be reached", async () => {
    const h = await start()
    const id = h.graph.add(mime())
    h.graph.throttle(2)
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 1 })
    expect((await h.messageOf(id)).content).toBe("parsed")
    const cursor = await cursorOf(h)
    h.graph.add(mime())
    h.graph.refuse(true)
    await expect(h.sync.run()).rejects.toThrow()
    expect(await cursorOf(h)).toEqual(cursor)
    expect(await count(h)).toBe(1)
    h.graph.refuse(false)
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 1 })
  })

  it("records a message larger than files.maxBytes and one mailparser cannot parse, and goes on", async () => {
    const h = await start()
    await h.settings.update({ "files.maxBytes": 2 * MEGABYTE }, SYSTEM)
    const big = h.graph.add(
      mime({
        attachments: [
          { fileName: "big.bin", contentType: "application/octet-stream", content: Buffer.alloc(2 * MEGABYTE) },
        ],
      }),
    )
    const unparsable = h.graph.add(Buffer.from(`Subject: broken\r\nX-Long: ${"a".repeat(1_100_000)}\r\n\r\nbody\r\n`))
    const malformed = h.graph.add(
      Buffer.from(
        "From: dana@example.com\r\nSubject: malformed\r\nContent-Type: multipart/mixed; boundary=XX\r\n\r\n--XX\r\n" +
          "Content-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n!!!not base64***\r\n--XX\r\nContent-Type: image/png\r\n",
        "latin1",
      ),
    )
    const valid = h.graph.add(mime({ subject: "valid" }))
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 4 })
    expect(await h.messageOf(big)).toMatchObject({ content: "too_large", reviewFlags: ["too_large"] })
    expect(await h.messageOf(unparsable)).toMatchObject({ content: "unparsed", reviewFlags: ["parse_failed"] })
    expect(await h.messageOf(malformed)).toMatchObject({ content: "parsed", subject: "malformed" })
    expect(await h.messageOf(valid)).toMatchObject({ content: "parsed", subject: "valid" })
  })

  it("stores U+0000 and an unpaired surrogate as U+FFFD, flags them, and goes on with the next message", async () => {
    const h = await start()
    const nul = h.graph.add(
      Buffer.from(
        "From: dana@example.com\r\nSubject: nul\r\nContent-Type: text/plain; charset=utf-8\r\n" +
          "Content-Transfer-Encoding: quoted-printable\r\n\r\nab=00cd\r\n",
        "latin1",
      ),
    )
    const afterNul = h.graph.add(mime({ subject: "after the nul" }))
    const cesu = h.graph.add(mime({ subject: "=?CESU-8?Q?=ED=A0=80?=" }))
    const afterCesu = h.graph.add(mime({ subject: "after the surrogate" }))
    expect(await h.sync.run()).toMatchObject({ status: "done", stored: 4 })
    const replacement = fromCodePoints(0xfffd)
    expect(await h.messageOf(nul)).toMatchObject({
      textBody: `ab${replacement}cd\n`,
      reviewFlags: ["invalid_characters"],
    })
    expect(await h.messageOf(cesu)).toMatchObject({ subject: replacement, reviewFlags: ["invalid_characters"] })
    expect(await h.messageOf(afterNul)).toMatchObject({ subject: "after the nul", reviewFlags: [] })
    expect(await h.messageOf(afterCesu)).toMatchObject({ subject: "after the surrogate", reviewFlags: [] })
    // Stage two takes them too.
    await h.processor.run()
    expect((await h.messageOf(cesu)).state).toBe("processed")
  })
})

describe("stage one: Hebrew, encodings, and parts", () => {
  it("stores Hebrew from UTF-8 and Windows-1255, quoted-printable and base64, encoded words, and file names", async () => {
    const h = await start()
    const mixed = `${SHALOM} Dana, order 1234 ${INVOICE}`
    const ids = {
      utf8Qp: h.graph.add(mime({ text: { content: SHALOM_OLAM, encoding: "quoted-printable" } })),
      utf8B64: h.graph.add(mime({ text: { content: SHALOM_OLAM, encoding: "base64" } })),
      cp1255Qp: h.graph.add(
        mime({ text: { content: SHALOM_OLAM, charset: "windows-1255", encoding: "quoted-printable" } }),
      ),
      cp1255Bit: h.graph.add(mime({ text: { content: SHALOM_OLAM, charset: "windows-1255", encoding: "8bit" } })),
      subject: h.graph.add(
        mime({
          subject: encodedWord(`${SHALOM} order`),
          text: { content: mixed },
          html: { content: `<p dir="rtl">${mixed}</p>` },
          attachments: [
            { fileName: `${INVOICE}.pdf`, contentType: "application/pdf", content: Buffer.from("%PDF-1.4\n%%EOF\n") },
          ],
        }),
      ),
      plainOnly: h.graph.add(mime({ text: { content: `${SHALOM}\nline two` } })),
    }
    await h.sync.run()
    for (const key of ["utf8Qp", "utf8B64", "cp1255Qp", "cp1255Bit"] as const)
      expect((await h.messageOf(ids[key])).textBody?.trim(), key).toBe(SHALOM_OLAM)
    expect(await h.messageOf(ids.subject)).toMatchObject({
      subject: `${SHALOM} order`,
      htmlBody: `<p dir="rtl">${mixed}</p>`,
    })
    expect((await h.messageOf(ids.subject)).textBody?.trim()).toBe(mixed)
    const [pdf] = await h.partsOf(ids.subject)
    expect(pdf).toMatchObject({ fileName: `${INVOICE}.pdf`, kind: "attachment", status: "clean" })
    expect(pdf?.storedSha256).toBe(pdf?.sha256)
    expect(await h.messageOf(ids.plainOnly)).toMatchObject({ textBody: `${SHALOM}\nline two`, htmlBody: null })
    // Every part and the raw message were clean: the raw MIME is kept.
    expect((await h.messageOf(ids.subject)).rawSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("keeps a message with an infected inline image and attachment, blocks both, and stores no copy of the bytes", async () => {
    const h = await start()
    const bad = eicar()
    const encoded = bad.toString("base64")
    const html = `<p>See <img src="cid:logo"> and <img src="data:image/png;base64,${encoded}"></p><a href="data:text/plain;base64,${encoded}">x</a>`
    const attachments = [
      { fileName: "logo.png", contentType: "image/png", content: bad, inline: true, contentId: "logo" },
      { fileName: "readme.txt", contentType: "text/plain", content: bad },
    ]
    const withText = h.graph.add(
      mime({ text: { content: "See the attached file." }, html: { content: html }, attachments }),
    )
    const withoutText = h.graph.add(mime({ html: { content: html }, attachments }))
    await h.sync.run()
    for (const id of [withText, withoutText]) {
      const stored = await h.messageOf(id)
      expect(stored).toMatchObject({ content: "parsed", rawSha256: null })
      expect(stored.htmlBody).toContain('src="cid:logo"')
      expect(stored.htmlBody).not.toContain("data:")
      expect((await h.partsOf(id)).map((part) => [part.kind, part.status, part.storedSha256])).toEqual([
        ["inline", "infected", null],
        ["attachment", "infected", null],
      ])
    }
    // Without a text part, the text comes from the sanitized HTML: no image, no data: URL.
    expect((await h.messageOf(withoutText)).textBody).toMatch(/^See\s+and\s+x$/)
    // Nothing of the bytes anywhere: no column, no stored file, raw or base64.
    const everything = await everythingStored(h)
    expect(everything).not.toContain("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")
    expect(everything).not.toContain(encoded)
    expect(
      await h.database.db
        .select()
        .from(storedFile)
        .where(eq(storedFile.sha256, sha256Of(bad))),
    ).toEqual([])
    for (const file of await filesUnder(h.dir)) {
      expect(file.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")).toBe(false)
      expect(file.includes(encoded)).toBe(false)
    }
    // One audit row per blocked part, with its message and file name.
    const audits = await h.database.db.select().from(auditLog).where(eq(auditLog.action, "file.blocked"))
    expect(audits).toHaveLength(4)
    expect(audits.map((row) => (row.details as { fileName: string }).fileName).sort()).toEqual([
      "logo.png",
      "logo.png",
      "readme.txt",
      "readme.txt",
    ])
  })

  it("leaves files waiting while the scanner is down, scans them again, and makes them unavailable once Graph says 404", async () => {
    const h = await start()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const attachment = { fileName: "notes.txt", contentType: "text/plain", content: Buffer.from("notes\n") }
    const later = h.graph.add(mime({ attachments: [attachment] }))
    const gone = h.graph.add(mime({ attachments: [{ ...attachment, content: Buffer.from("other\n") }] }))
    await h.sync.run()
    expect((await h.partsOf(later))[0]).toMatchObject({ status: "waiting", storedSha256: null })
    expect(await h.messageOf(later)).toMatchObject({ rawStatus: "waiting", rawSha256: null })
    // Still down: nothing changes.
    expect(await h.retry.run()).toMatchObject({ messages: 2, stillWaiting: 2 })
    // The scanner is back; one message is gone from the mailbox.
    await h.settings.update({ "scanner.address": clamd.address }, SYSTEM)
    h.graph.vanish(gone)
    expect(await h.retry.run()).toMatchObject({ messages: 2, decided: 1, unavailable: 1 })
    const [part] = await h.partsOf(later)
    expect(part).toMatchObject({ status: "clean", storedSha256: part?.sha256 })
    expect(await h.messageOf(later)).toMatchObject({
      rawStatus: "clean",
      rawSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((await h.partsOf(gone))[0]).toMatchObject({ status: "unavailable", unavailableReason: "graph_404" })
    expect(await h.retry.run()).toMatchObject({ messages: 0 })
  })
})

describe("the intake source", () => {
  it("discards what a held $value fetched when the mailbox changes meanwhile, and stops the round", async () => {
    const h = await start()
    const id = h.graph.add(mime())
    const hold = h.graph.hold(id)
    const round = h.sync.run()
    await hold.reached
    const other = "other-intake@example.com"
    h.graph.allow(other)
    // The change does not wait for the fetch: nothing holds the source while Graph answers.
    await h.settings.update({ "graph.mailbox": other }, SYSTEM)
    hold.release()
    expect(await round).toMatchObject({ status: "source_changed", stored: 0 })
    expect(await count(h)).toBe(0)
    expect(await cursorOf(h)).toBeUndefined()
    const sources = await h.database.db.select().from(intakeSource)
    expect(sources.map((source) => [source.mailbox, source.current]).sort()).toEqual([
      [h.graph.mailbox, false],
      [other, true],
    ])
  })

  it("makes a mailbox change wait for a store that holds the source", async () => {
    const h = await start()
    const [source] = await h.database.db.select().from(intakeSource).where(eq(intakeSource.current, true))
    let changed = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const store = h.database.db.transaction(async (tx) => {
      await tx.execute(sql`select current from intake_source where id = ${source?.id} for share`)
      await held
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const change = h.settings.update({ "graph.mailbox": "third@example.com" }, SYSTEM).then(() => {
      changed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(changed).toBe(false)
    release()
    await store
    await change
    expect(changed).toBe(true)
  })

  it("makes the environment's mailbox current at restart, keeping the old source and its cursors", async () => {
    const h = await start()
    h.graph.add(mime({ subject: "old mailbox" }))
    await h.sync.run()
    const [old] = await h.database.db.select().from(intakeSource).where(eq(intakeSource.current, true))
    const next = "next-intake@example.com"
    h.graph.allow(next)
    const newId = h.graph.add(mime({ subject: "new mailbox" }), { mailbox: next })
    // The worker restarts with MAANE_GRAPH_MAILBOX set to another mailbox.
    const restarted = new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), {
      "graph.mailbox": next,
    })
    const current = await reconcileIntakeSource(h.database.db, restarted)
    const sources = await h.database.db.select().from(intakeSource)
    expect(sources.find((source) => source.current)?.id).toBe(current?.id)
    expect(sources.find((source) => source.id === old?.id)?.current).toBe(false)
    expect(sources.find((source) => source.current)?.mailbox).toBe(next)
    expect(
      (
        await h.database.db
          .select()
          .from(intakeCursor)
          .where(eq(intakeCursor.sourceId, old?.id ?? ""))
      ).length,
    ).toBe(2)
    const sync = new IntakeSync({ db: h.database.db, settings: restarted, files: h.files, graph: h.gateway })
    expect(await sync.run()).toMatchObject({ status: "done", stored: 1 })
    expect((await h.messageOf(newId)).sourceId).toBe(current?.id)
    // The old source is read-only: a sync with the old settings finds it no longer current.
    expect(await h.sync.run()).toMatchObject({ status: "no_source" })
  })

  it("makes a waiting file of an old mailbox unavailable when Graph refuses that mailbox", async () => {
    const h = await start()
    await h.settings.update({ "scanner.address": await refusedAddress() }, SYSTEM)
    const id = h.graph.add(
      mime({ attachments: [{ fileName: "a.txt", contentType: "text/plain", content: Buffer.from("a\n") }] }),
    )
    await h.sync.run()
    const other = "moved-intake@example.com"
    h.graph.allow(other)
    await h.settings.update({ "graph.mailbox": other, "scanner.address": clamd.address }, SYSTEM)
    h.graph.deny(h.graph.mailbox)
    expect(await h.retry.run()).toMatchObject({ unavailable: 1 })
    expect((await h.partsOf(id))[0]).toMatchObject({ status: "unavailable", unavailableReason: "graph_403" })
    expect((await h.messageOf(id)).rawStatus).toBe("unavailable")
  })
})

describe("the Graph connection test", () => {
  it("reads only the Inbox folder's metadata and reports Entra's and Graph's refusals by their codes", async () => {
    const h = await start()
    h.graph.add(mime())
    const before = h.graph.requests.length
    expect(await graphTest(h.settings, h.gateway)).toMatchObject({
      ok: true,
      problem: null,
      mailbox: h.graph.mailbox,
    })
    const graphRequests = h.graph.requests.slice(before).filter((line) => line.includes("/v1.0/"))
    expect(graphRequests).toHaveLength(1)
    expect(graphRequests[0]).toMatch(/^GET \/v1\.0\/users\/[^/]+\/mailFolders\/inbox\?/)
    expect(await count(h)).toBe(0)
    expect(await cursorOf(h)).toBeUndefined()

    // Another mailbox the application may not read.
    await h.settings.update({ "graph.mailbox": "someone-else@example.com" }, SYSTEM)
    expect(await graphTest(h.settings, h.gateway)).toMatchObject({
      ok: false,
      problem: "access_denied",
      code: "ErrorAccessDenied",
      status: 403,
    })
    // A wrong secret, assembled at run time.
    await h.settings.update(
      { "graph.mailbox": h.graph.mailbox, "graph.clientSecret": `${h.graph.clientSecret}x` },
      SYSTEM,
    )
    expect(await graphTest(h.settings, new GraphGateway(h.graph.endpoints))).toMatchObject({
      ok: false,
      problem: "credential",
      code: "AADSTS7000215",
    })
    // Not configured.
    const empty = new Settings(h.database.db, createSettingsCipher([{ version: 1, value: h.cipherKey }]), {
      "graph.tenantId": "",
    })
    expect(await graphTest(empty, h.gateway)).toMatchObject({ ok: false, problem: "not_configured" })
  })
})
