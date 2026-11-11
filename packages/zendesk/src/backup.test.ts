import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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
    sleep: async () => {},
    maxAttempts,
  })
}

const backup = (maxAttempts?: number) =>
  runBackup({ client: client(maxAttempts), archive: new Archive(dir), maxFileBytes: 1024 })

async function manifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as Manifest
}

describe("backup", () => {
  it("saves the raw records, every ticket's comments and audits, and each file or its failure", async () => {
    const result = await backup()
    expect(result.coveredUntil).not.toBeNull()

    // Raw pages are stored exactly as Zendesk sent them.
    const firstPage = await readFile(join(dir, "raw/incremental/tickets/000001.json"), "utf8")
    expect(JSON.parse(firstPage).tickets[0]).toMatchObject({ id: 1, encoded_id: "X1Y" })
    expect(await readdir(join(dir, "raw/collections/brands/000001"))).toEqual(["000001.json", "000002.json"])
    expect(await readdir(join(dir, "raw/incremental/organizations"))).toHaveLength(2)

    const files = (await manifest()).files
    const invoice = zendesk.allFiles().find((f) => f.id === 101)
    expect(files["101"]).toMatchObject({ status: "ok", fileName: "invoice.pdf", ticketId: "1", bytes: 64 })
    expect(files["101"]?.sha256).toBe(
      createHash("sha256")
        .update(invoice?.content ?? "")
        .digest("hex"),
    )
    expect(files["102"]).toMatchObject({ status: "ok", inline: true })
    expect(files["201"]).toMatchObject({ status: "failed" })
    expect(files["201"]?.error).toContain("larger than the limit")
    expect(files["301"]).toMatchObject({ status: "failed" })
    expect(files["301"]?.error).toContain("404")

    // The token went to the API only, never to the file host after the redirect.
    expect(zendesk.fileHostAuthorizations).toEqual([])
    // Inline images were asked for.
    expect(zendesk.requests.some((r) => r.includes("comments.json?include_inline_images=true"))).toBe(true)

    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts).toMatchObject({
      tickets: 4,
      deletedTickets: 1,
      goneTickets: 1,
      comments: 5,
      internalNotes: 1,
      users: 3,
      organizations: 3,
      filesOk: 2,
      inlineImages: 1,
      filesFailed: 2,
    })
    expect(check.warnings.join("\n")).toContain("could not be downloaded")
  })

  it("resumes a run that stopped part way, with the same result as an uninterrupted run", async () => {
    // The stand-in stops answering once the first ticket is saved, in the middle of its files.
    zendesk.failAfter = 28
    await expect(backup(2)).rejects.toThrow("500")
    expect((await checkArchive(dir)).problems).not.toEqual([])

    zendesk.failAfter = Number.POSITIVE_INFINITY
    await backup()
    const resumed = await manifest()
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.tickets).toBe(4)

    // The page numbers of the ticket export have no gap and no duplicate. The second run read the stream
    // from the saved cursor: one more page, empty, at its end.
    expect(await readdir(join(dir, "raw/incremental/tickets"))).toEqual([
      "000001.json",
      "000002.json",
      "000003.json",
      "000004.json",
    ])
    const last = JSON.parse(await readFile(join(dir, "raw/incremental/tickets/000004.json"), "utf8"))
    expect(last).toMatchObject({ tickets: [], end_of_stream: true })
    expect(Object.fromEntries(Object.entries(resumed.files).map(([id, f]) => [id, f.status]))).toEqual({
      "101": "ok",
      "102": "ok",
      "201": "failed",
      "301": "failed",
    })
  })

  it("continues from the saved position and keeps every earlier version of a ticket", async () => {
    await backup()
    const before = zendesk.requests.length
    zendesk.addComment(1, { id: 14, public: true, body: "Thanks", files: [] })
    const second = await backup()
    expect(second.ticketsSaved).toBe(1)

    // The second run asked only for what changed, from the saved cursor.
    const later = zendesk.requests.slice(before)
    expect(later.filter((r) => r.includes("/incremental/tickets/")).every((r) => r.includes("cursor=pos-"))).toBe(true)
    expect(later.filter((r) => /tickets\/\d+\/comments/.test(r)).every((r) => r.includes("/tickets/1/"))).toBe(true)

    expect(await readdir(join(dir, "raw/tickets/1"))).toHaveLength(2)
    const check = await checkArchive(dir)
    expect(check.problems).toEqual([])
    expect(check.counts.comments).toBe(6)
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

  it("refuses an archive of another account and a second run at the same time", async () => {
    await backup()
    const other = new ZendeskClient({
      apiOrigin: "https://other.example.com",
      authorization: "x",
      sleep: async () => {},
    })
    await expect(runBackup({ client: other, archive: new Archive(dir), maxFileBytes: 1024 })).rejects.toThrow(
      "another Zendesk account",
    )

    await writeFile(join(dir, ".lock"), String(process.ppid))
    await expect(backup()).rejects.toThrow("another run")
  })
})

describe("check", () => {
  it("finds a file whose content changed and a ticket whose comments are missing", async () => {
    await backup()
    const files = (await manifest()).files
    const sha = files["101"]?.sha256 ?? ""
    await writeFile(join(dir, "files", sha.slice(0, 2), sha), "changed")
    const folder = (await readdir(join(dir, "raw/tickets/2")))[0] ?? ""
    await rm(join(dir, "raw/tickets/2", folder, "comments-000001.json"))

    const problems = (await checkArchive(dir)).problems.join("\n")
    expect(problems).toContain("file 101: its content does not match")
    expect(problems).toContain("ticket 2: the comments or audits of its newest version are missing")
  })

  it("refuses a folder that is not an archive", async () => {
    expect((await checkArchive(dir)).problems).toEqual(["archive.json is missing or is not a Maane Zendesk archive"])
  })
})
