import { createHash } from "node:crypto"
import { appendFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Archive, type Manifest } from "./archive.ts"
import { runBackup } from "./backup.ts"
import { checkArchive } from "./check.ts"
import { ZendeskClient } from "./http.ts"
import { StandInZendesk } from "./testing/stand-in.ts"

let zendesk: StandInZendesk
let dir: string

beforeEach(async () => {
  zendesk = new StandInZendesk()
  await zendesk.start()
  dir = await mkdtemp(join(tmpdir(), "maane-zendesk-"))
})

afterEach(async () => {
  await zendesk.stop()
  await rm(dir, { recursive: true, force: true })
})

function client(maxAttempts = 3): ZendeskClient {
  return new ZendeskClient({
    apiOrigin: zendesk.apiOrigin,
    authorization: zendesk.authorization,
    allowHttp: true,
    // The stand-in's file host is the loopback address: allowed here, never by the command line.
    fileHostAllowed: (host) => host === "127.0.0.1",
    sleep: async () => {},
    maxAttempts,
  })
}

const backup = (maxAttempts?: number) =>
  runBackup({ client: client(maxAttempts), archive: new Archive(dir), maxFileBytes: 1024 })

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest
}

const statuses = async () =>
  Object.fromEntries(Object.entries((await manifest()).files).map(([id, f]) => [id, f.status]))

describe("backup", () => {
  it("saves the raw records, every ticket's comments, audits, side conversations, and each file or its failure", async () => {
    const result = await backup()
    expect(result.coveredUntil).not.toBeNull()
    expect(result.sideConversations).toBe("available")

    // Raw pages are stored exactly as Zendesk sent them, with metric sets asked for.
    const firstPage = await readFile(join(dir, "raw/incremental/tickets/000001.json"), "utf8")
    expect(JSON.parse(firstPage).tickets[0]).toMatchObject({ id: 1, encoded_id: "X1Y" })
    expect(
      zendesk.requests.some((r) => r.includes("incremental/tickets/cursor.json") && r.includes("include=metric_sets")),
    ).toBe(true)
    expect(await readdir(join(dir, "raw/collections/brands/000001"))).toEqual(["000001.json", "000002.json"])
    expect(await readdir(join(dir, "raw/collections/satisfaction_ratings/000001"))).toHaveLength(2)

    const files = (await manifest()).files
    const invoice = zendesk.allFiles().find((f) => f.id === 101)
    expect(files["101"]).toMatchObject({ status: "ok", fileName: "invoice.pdf", ticketId: "1", bytes: 64 })
    expect(files["101"]?.sha256).toBe(
      createHash("sha256")
        .update(invoice?.content ?? "")
        .digest("hex"),
    )
    expect(files["102"]).toMatchObject({ status: "ok", inline: true })
    expect(files["401"]).toMatchObject({ status: "ok", commentId: "side:9001" })
    expect(files["201"]?.error).toContain("larger than the limit")
    expect(files["301"]?.error).toContain("404")

    // The token went to the API only, never to the file host after the redirect.
    expect(zendesk.fileHostAuthorizations).toEqual([])
    expect(zendesk.requests.some((r) => r.includes("comments.json?include_inline_images=true"))).toBe(true)

    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts).toMatchObject({
      tickets: 4,
      deletedTickets: 1,
      goneTickets: 1,
      comments: 5,
      internalNotes: 1,
      sideConversations: 1,
      users: 3,
      organizations: 3,
      filesOk: 3,
      inlineImages: 1,
      filesFailed: 2,
    })
    expect(check.warnings.join("\n")).toContain("could not be downloaded")
  })

  it("takes the covered time from Zendesk's clock, less the minute the export leaves out", async () => {
    const result = await backup()
    const last = zendesk.lastDate ?? ""
    expect(result.coveredUntil).toBe(new Date(Date.parse(last) - 60_000).toISOString())
  })

  it("resumes a run that stopped part way, with the same result as an uninterrupted run", async () => {
    zendesk.failWhen = (path) => path.includes("/tickets/2/")
    await expect(backup(2)).rejects.toThrow("500")
    expect((await checkArchive(dir)).problems).not.toEqual([])

    zendesk.failWhen = null
    await backup()
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.tickets).toBe(4)
    // The second run read the ticket stream from the saved cursor: one more page, empty, at its end.
    expect(await readdir(join(dir, "raw/incremental/tickets"))).toEqual([
      "000001.json",
      "000002.json",
      "000003.json",
      "000004.json",
    ])
    expect(await statuses()).toEqual({ "101": "ok", "102": "ok", "201": "failed", "301": "failed", "401": "ok" })
  })

  it("tries a failed file again on the next run, with a fresh link, and records it once it arrives", async () => {
    zendesk.failWhen = (path) => path.startsWith("/attachments/token/t102/")
    await backup()
    expect((await statuses())["102"]).toBe("failed")
    zendesk.failWhen = null
    await backup()
    expect((await statuses())["102"]).toBe("ok")
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("continues from the saved position and keeps every earlier version of a ticket", async () => {
    await backup()
    const before = zendesk.requests.length
    zendesk.addComment(1, { id: 14, public: true, body: "Thanks", files: [] })
    const second = await backup()
    expect(second.ticketsSaved).toBe(1)
    const later = zendesk.requests.slice(before)
    expect(later.filter((r) => r.includes("/incremental/tickets/")).every((r) => r.includes("cursor=pos-"))).toBe(true)
    expect(await readdir(join(dir, "raw/tickets/1"))).toHaveLength(2)
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.comments).toBe(6)
  })

  it("skips side conversations on an account without them", async () => {
    zendesk.sideConversationsAvailable = false
    const result = await backup()
    expect(result.sideConversations).toBe("unavailable")
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.warnings.some((w) => w.includes("side conversations could not be read"))).toBe(true)
    // Asked again on the next run: the add-on may have been added since.
    zendesk.sideConversationsAvailable = true
    zendesk.addComment(1, { id: 16, public: true, body: "Again", files: [] })
    expect((await backup()).sideConversations).toBe("available")
  })

  it("adds side conversations to tickets saved without them once a later run can read them", async () => {
    zendesk.sideConversationsAvailable = false
    await backup()
    zendesk.sideConversationsAvailable = true
    const result = await backup()
    expect(result.sideConversations).toBe("available")
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.sideConversations).toBe(1)
    expect(check.warnings.some((w) => w.includes("side conversations could not be read"))).toBe(false)
    expect((await manifest()).files["401"]?.status).toBe("ok")
  })

  it("records the files of pages saved before a ticket was deleted between runs", async () => {
    // The first run saves ticket 2's comments, then stops before its files.
    zendesk.failWhen = (path) => path.includes("/tickets/2/audits")
    await expect(backup(2)).rejects.toThrow("500")
    zendesk.failWhen = null
    // The ticket is deleted before the next run.
    const ticket = zendesk.tickets.get(2)
    if (ticket) ticket.gone = true
    await backup()
    expect((await manifest()).files["201"]).toBeDefined()
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("records those files also when the export lists the ticket as deleted", async () => {
    zendesk.failWhen = (path) => path.includes("/tickets/2/audits")
    await expect(backup(2)).rejects.toThrow("500")
    zendesk.failWhen = null
    zendesk.setStatus(2, "deleted")
    await backup()
    expect((await manifest()).files["201"]).toBeDefined()
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("records the files of side conversation pages added before the ticket was deleted", async () => {
    // Saved without side conversations; the next run adds sc-1's events page, then stops before its file.
    zendesk.sideConversationsAvailable = false
    await backup()
    zendesk.sideConversationsAvailable = true
    zendesk.brokenSideConversations.push("sc-broken")
    await expect(backup()).rejects.toThrow("404")
    expect((await manifest()).files["401"]).toBeUndefined()
    // Ticket 1 is deleted before the next run.
    zendesk.brokenSideConversations.length = 0
    zendesk.deletedDuringSave.add(1)
    await backup()
    expect((await manifest()).files["401"]).toBeDefined()
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("still adds side conversations when the export returns the ticket with the same updated_at", async () => {
    zendesk.sideConversationsAvailable = false
    await backup()
    zendesk.sideConversationsAvailable = true
    zendesk.relist(1)
    await backup()
    expect((await manifest()).files["401"]?.status).toBe("ok")
    const check = await checkArchive(dir)
    expect(check.warnings.some((w) => w.includes("side conversations could not be read"))).toBe(false)
  })

  it("replaces a stored copy whose size went wrong with a verified download", async () => {
    await backup()
    const sha = (await manifest()).files["101"]?.sha256 ?? ""
    await writeFile(join(dir, "files", sha.slice(0, 2), sha), "x")
    await backup()
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("keeps side conversations for other tickets when one ticket is deleted while it is saved", async () => {
    zendesk.deletedDuringSave.add(1)
    const result = await backup()
    expect(result.sideConversations).toBe("available")
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.goneTickets).toBe(2)
  })

  it("repairs a half-written line of the page index on the next run", async () => {
    await backup()
    await appendFile(join(dir, "raw-index.jsonl"), '{"path":"raw/x","sha')
    expect((await checkArchive(dir)).problems.join("\n")).toContain("raw-index.jsonl line")
    await backup()
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("fetches a stored file again when it went missing after it was recorded", async () => {
    await backup()
    const sha = (await manifest()).files["101"]?.sha256 ?? ""
    await rm(join(dir, "files", sha.slice(0, 2), sha))
    await backup()
    expect((await manifest()).files["101"]?.status).toBe("ok")
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("records a collection the account cannot read and goes on", async () => {
    zendesk.forbiddenCollections.add("custom_statuses")
    const result = await backup()
    expect(result.collectionsUnavailable).toEqual(["custom_statuses"])
    const note = JSON.parse(
      await readFile(join(dir, "raw/collections/custom_statuses/000001/unavailable.json"), "utf8"),
    )
    expect(note).toMatchObject({ status: 403 })
    expect((await checkArchive(dir)).problems).toEqual([])
  })

  it("refuses a next link to another host, so the token never leaves the API origin", async () => {
    zendesk.foreignLinkIn = "groups"
    await expect(backup()).rejects.toThrow("refused a link to another host")
  })

  it("refuses a ticket ID that would leave the archive folder", async () => {
    zendesk.badTicketId = true
    await expect(backup()).rejects.toThrow("not a number")
  })

  it("refuses another account's archive, and never takes over a lock, also a stale one", async () => {
    await backup()
    const other = new ZendeskClient({
      apiOrigin: "https://other.example.com",
      authorization: "x",
      sleep: async () => {},
    })
    await expect(runBackup({ client: other, archive: new Archive(dir), maxFileBytes: 1024 })).rejects.toThrow(
      "another Zendesk account",
    )
    // A lock left by a process that is long gone: still refused, with the file to remove.
    await writeFile(join(dir, ".lock"), JSON.stringify({ pid: 999_999_999 }))
    await expect(backup()).rejects.toThrow("remove")
    await rm(join(dir, ".lock"))
    await backup()
  })

  it("refuses a path outside the archive", () => {
    expect(() => new Archive(dir).path("..", "elsewhere")).toThrow("outside the archive")
  })
})

describe("check", () => {
  it("finds a changed file, a changed page, a missing page, and a missing raw folder", async () => {
    await backup()
    const files = (await manifest()).files
    const sha = files["102"]?.sha256 ?? ""
    await writeFile(join(dir, "files", sha.slice(0, 2), sha), "changed")
    const folder = (await readdir(join(dir, "raw/tickets/1")))[0] ?? ""
    await rm(join(dir, "raw/tickets/1", folder, "comments-000001.json"))
    // Still valid JSON, but not what Zendesk sent.
    await writeFile(join(dir, "raw/incremental/users/000001.json"), '{"users":[],"end_of_stream":false}')

    const problems = (await checkArchive(dir)).problems.join("\n")
    expect(problems).toContain("file 102: its content does not match")
    expect(problems).toContain("comments page 000001 is missing")
    expect(problems).toContain("raw/incremental/users/000001.json changed after it was written")

    await rm(join(dir, "raw"), { recursive: true })
    expect((await checkArchive(dir)).problems.join("\n")).toContain("raw/ cannot be read")
  })

  it("checks files of every saved version, not only the newest", async () => {
    await backup()
    // Ticket 1 changes; its older version keeps file 101, which the newest version no longer lists.
    const ticket = zendesk.tickets.get(1)
    if (ticket) ticket.comments = ticket.comments.slice(1)
    zendesk.addComment(1, { id: 15, public: true, body: "Later", files: [] })
    await backup()
    const sha = (await manifest()).files["101"]?.sha256 ?? ""
    await rm(join(dir, "files", sha.slice(0, 2), sha))
    expect((await checkArchive(dir)).problems.join("\n")).toContain("file 101")
  })

  it("refuses a folder that is not an archive", async () => {
    expect((await checkArchive(dir)).problems).toEqual(["archive.json is missing or is not a Maane Zendesk archive"])
  })

  it("ignores a temporary file a crash left behind", async () => {
    await backup()
    await appendFile(join(dir, "raw/collections/groups/000001/.tmp-0123456789ab"), "{ half a page")
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
  })
})
