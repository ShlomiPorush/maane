import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Archive, type ArchiveState } from "./archive.ts"
import { ArchiveReader } from "./reader.ts"

// The archive reader's own behavior, on files written here (no backup run): state.json is parsed again only when the
// file changed, and the newest record of each ticket and user is chosen page by page.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maane-reader-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const page = async (folder: string, name: string, value: unknown) => {
  await mkdir(join(dir, folder), { recursive: true })
  await writeFile(join(dir, folder, name), JSON.stringify(value))
}

describe("the archive reader", () => {
  it("parses state.json again only when the backup saved it again", async () => {
    const archive = new Archive(dir)
    const state = { ...(await archive.state()), runs: 7, coveredUntil: "2025-05-01T09:00:00.000Z" } as ArchiveState
    await archive.saveState(state)
    const reader = new ArchiveReader(dir)
    const parsed = vi.spyOn(reader.archive, "state")
    const first = await reader.mark()
    await reader.mark()
    await reader.mark()
    expect(first).toEqual({ runs: 7, coveredUntil: "2025-05-01T09:00:00.000Z", locked: false })
    expect(parsed).toHaveBeenCalledTimes(1)
    // The same length of text (7 to 8 runs, a time of the same form), saved through a temporary name and a rename.
    await archive.saveState({ ...state, runs: 8, coveredUntil: "2025-05-01T09:01:00.000Z" })
    expect(await reader.mark()).toEqual({ runs: 8, coveredUntil: "2025-05-01T09:01:00.000Z", locked: false })
    expect(parsed).toHaveBeenCalledTimes(2)
    // The backup's lock is looked at every time.
    await writeFile(join(dir, ".lock"), "{}\n")
    expect((await reader.mark()).locked).toBe(true)
    expect(parsed).toHaveBeenCalledTimes(2)
  })

  it("keeps the newest record of each ticket and user across the export's pages", async () => {
    const at = (minute: number) => `2025-05-01T09:${String(minute).padStart(2, "0")}:00Z`
    await page("raw/incremental/tickets", "000001.json", {
      tickets: [
        { id: 1, subject: "first", updated_at: at(1) },
        { id: 2, subject: "newest of 2", updated_at: at(5) },
        { id: 3, subject: "tie, earlier page", updated_at: at(3) },
      ],
    })
    await page("raw/incremental/tickets", "000002.json", {
      tickets: [
        { id: 1, subject: "newer", updated_at: at(2) },
        { id: 2, subject: "older of 2", updated_at: at(4) },
        { id: 3, subject: "tie, later page", updated_at: at(3) },
        { id: "x", subject: "not an ID", updated_at: at(9) },
      ],
    })
    await page("raw/incremental/users", "000001.json", { users: [{ id: 5, name: "Before" }] })
    await page("raw/incremental/users", "000002.json", {
      users: [
        { id: 5, name: "After" },
        { id: 6, name: "Other" },
      ],
    })
    const reader = new ArchiveReader(dir)
    const tickets = await reader.tickets()
    expect([...tickets.entries()].map(([id, record]) => [id, record.subject])).toEqual([
      ["1", "newer"],
      ["2", "newest of 2"],
      ["3", "tie, later page"],
    ])
    const users = await reader.users()
    expect([...users.values()].map((user) => user.name)).toEqual(["After", "Other"])
  })
})
