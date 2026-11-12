import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { opendir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  Archive,
  type ArchiveState,
  type Manifest,
  RAW_INDEX,
  type RawIndexEntry,
  seqName,
  stamp,
  type VersionMarker,
} from "./archive.ts"
import {
  COLLECTION_SOURCES,
  INCREMENTAL_SOURCES,
  nextPage,
  type ZendeskComment,
  type ZendeskSideConversationEvent,
} from "./sources.ts"

export interface CheckCounts {
  jsonFiles: number
  tickets: number
  deletedTickets: number
  goneTickets: number
  comments: number
  internalNotes: number
  sideConversations: number
  users: number
  organizations: number
  filesOk: number
  inlineImages: number
  filesFailed: number
}

export interface CheckResult {
  /** Problems make the archive incomplete or unreadable. */
  problems: string[]
  /** Explicit failures and other facts the owner should know; they do not fail the check. */
  warnings: string[]
  counts: CheckCounts
  coveredUntil: string | null
}

/** Pages of one list: sequence number to whether that page links to a next one. */
type Pages = Map<number, boolean>

/**
 * Reads the whole archive without any access to Zendesk, one file at a time:
 * - every raw page is listed in raw-index.jsonl with the hash it was written with, and still has it;
 * - every export has its pages from the first to the saved position without a gap, ending the stream;
 * - every ticket's newest version has its marker and every page of the lists the marker names, each list linking from
 *   one page to the next and ending on a page without a next link;
 * - each collection's newest run is complete, or records why the account could not read it;
 * - every file any saved version lists, and every file in manifest.json, is stored with a matching SHA-256 and size,
 *   or recorded as an explicit failure.
 */
export async function checkArchive(root: string): Promise<CheckResult> {
  const archive = new Archive(root)
  const problems: string[] = []
  const warnings: string[] = []
  const counts: CheckCounts = {
    jsonFiles: 0,
    tickets: 0,
    deletedTickets: 0,
    goneTickets: 0,
    comments: 0,
    internalNotes: 0,
    sideConversations: 0,
    users: 0,
    organizations: 0,
    filesOk: 0,
    inlineImages: 0,
    filesFailed: 0,
  }
  const result: CheckResult = { problems, warnings, counts, coveredUntil: null }

  const info = await archive.info().catch(() => undefined)
  if (!info || info.format !== ARCHIVE_FORMAT || info.version !== ARCHIVE_VERSION) {
    problems.push("archive.json is missing or is not a Maane Zendesk archive")
    return result
  }
  let state: ArchiveState
  let manifest: Manifest
  try {
    state = await archive.state()
    manifest = await archive.manifest()
  } catch (error) {
    problems.push(`state.json or manifest.json cannot be read: ${(error as Error).message}`)
    return result
  }
  result.coveredUntil = state.coveredUntil
  if (!state.coveredUntil) warnings.push("the time the archive covers is unknown (Zendesk sent no Date header)")

  let index: Map<string, RawIndexEntry>
  try {
    index = await readIndex(archive.path(RAW_INDEX), problems)
  } catch (error) {
    problems.push(`${RAW_INDEX} cannot be read: ${(error as Error).message}`)
    return result
  }

  const files: string[] = []
  try {
    await collectFiles(archive.path("raw"), "", files)
  } catch (error) {
    problems.push(`raw/ cannot be read: ${(error as Error).message}`)
    return result
  }
  files.sort()

  // What the pages say, kept small: no page body stays in memory.
  const exportPages = new Map<string, Pages>() // source -> seq -> end_of_stream
  const tickets = new Map<string, { updatedAt: string; status: string }>()
  const users = new Set<string>()
  const organizations = new Set<string>()
  const lists = new Map<string, Map<string, Pages>>() // "tickets/<id>/<version>" -> list -> pages
  const markers = new Map<string, VersionMarker>() // "tickets/<id>/<version>" -> marker
  const collections = new Map<string, Map<string, Pages | "unavailable">>() // name -> run -> pages
  const expectedFiles = new Map<string, { inline: boolean }>()
  const tallies = new Map<string, { comments: number; internal: number }>() // folder -> counts
  const present = new Set<string>()

  for (const file of files) {
    // A temporary file a crash left behind; the page it would have become is checked by its own name.
    if (file.split("/").at(-1)?.startsWith(".tmp-")) continue
    const relativePath = `raw/${file}`
    present.add(relativePath)
    let text: string
    try {
      text = await readFile(archive.path(relativePath), "utf8")
    } catch (error) {
      problems.push(`${relativePath} cannot be read: ${(error as Error).message}`)
      continue
    }
    const indexed = index.get(relativePath)
    const hash = createHash("sha256").update(text).digest("hex")
    if (!indexed) warnings.push(`${relativePath} is not in ${RAW_INDEX} (left by an interrupted run)`)
    else if (indexed.sha256 !== hash || indexed.bytes !== Buffer.byteLength(text)) {
      problems.push(`${relativePath} changed after it was written`)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
      counts.jsonFiles++
    } catch {
      problems.push(`${relativePath} is not valid JSON`)
      continue
    }
    const page = json as Record<string, unknown>
    const exportPage = /^incremental\/([^/]+)\/(\d+)\.json$/.exec(file)
    const ticketList = /^(tickets\/\d+\/[^/]+)\/(comments|audits|side_conversations)-(\d+)\.json$/.exec(file)
    const eventsPage = /^(tickets\/\d+\/[^/]+)\/side_conversations\/([^/]+)\/events-(\d+)\.json$/.exec(file)
    const marker = /^(tickets\/\d+\/[^/]+)\/version\.json$/.exec(file)
    const collectionPage = /^collections\/([^/]+)\/([^/]+)\/(\d+)\.json$/.exec(file)
    const unavailable = /^collections\/([^/]+)\/([^/]+)\/unavailable\.json$/.exec(file)

    if (exportPage) {
      const [, source = "", seq = "0"] = exportPage
      mapOf(exportPages, source).set(Number(seq), page.end_of_stream === true)
      if (source === "tickets") {
        for (const t of (page.tickets ?? []) as { id: unknown; updated_at: string; status?: string }[]) {
          const id = String(t.id)
          const known = tickets.get(id)
          if (!known || known.updatedAt < t.updated_at) {
            tickets.set(id, { updatedAt: t.updated_at, status: t.status ?? "" })
          }
        }
      } else if (source === "users") {
        for (const u of (page.users ?? []) as { id: unknown }[]) users.add(String(u.id))
      } else if (source === "organizations") {
        for (const o of (page.organizations ?? []) as { id: unknown }[]) organizations.add(String(o.id))
      }
    } else if (ticketList) {
      const [, folder = "", list = "", seq = "0"] = ticketList
      mapOf(mapOf(lists, folder), list).set(Number(seq), nextPage(json) !== null)
      if (list === "comments") {
        const tally = tallies.get(folder) ?? { comments: 0, internal: 0 }
        for (const comment of (page.comments ?? []) as ZendeskComment[]) {
          tally.comments++
          if (comment.public === false) tally.internal++
          for (const a of comment.attachments ?? []) expectedFiles.set(String(a.id), { inline: a.inline === true })
        }
        tallies.set(folder, tally)
      }
    } else if (eventsPage) {
      const [, folder = "", sideId = "", seq = "0"] = eventsPage
      mapOf(mapOf(lists, folder), `events:${sideId}`).set(Number(seq), nextPage(json) !== null)
      for (const event of (page.events ?? []) as ZendeskSideConversationEvent[]) {
        for (const a of event.message?.attachments ?? []) expectedFiles.set(String(a.id), { inline: false })
      }
    } else if (marker) {
      markers.set(marker[1] ?? "", json as VersionMarker)
    } else if (collectionPage) {
      const [, name = "", run = "", seq = "0"] = collectionPage
      const runs = mapOf(collections, name)
      const pages = runs.get(run)
      const map = pages instanceof Map ? pages : new Map<number, boolean>()
      map.set(Number(seq), nextPage(json) !== null)
      runs.set(run, map)
    } else if (unavailable) {
      const [, name = "", run = ""] = unavailable
      if (typeof page.status !== "number") problems.push(`${relativePath} does not say why the collection is missing`)
      else mapOf(collections, name).set(run, "unavailable")
    }
  }

  for (const path of index.keys()) {
    if (!present.has(path)) problems.push(`${path} is listed in ${RAW_INDEX} but missing`)
  }

  // Exports: every page from the first to the saved position, and each export reached its end.
  for (const source of INCREMENTAL_SOURCES) {
    const position = state.exports[source.name]
    const pages = exportPages.get(source.name) ?? new Map<number, boolean>()
    if (!position) {
      problems.push(`the ${source.name} export never ran`)
      continue
    }
    for (let seq = 1; seq < position.seq; seq++) {
      if (!pages.has(seq)) problems.push(`raw/incremental/${source.name}/${seqName(seq)}.json is missing`)
    }
    if (!position.caughtUp) problems.push(`the ${source.name} export never reached the end of the stream`)
    else if (pages.get(position.seq - 1) !== true) {
      problems.push(`the last page of the ${source.name} export does not end the stream`)
    }
  }
  counts.users = users.size
  counts.organizations = organizations.size

  // Tickets: the newest version of each has its marker and every page of every list the marker names.
  for (const [id, ticket] of tickets) {
    if (ticket.status === "deleted") {
      counts.deletedTickets++
      continue
    }
    counts.tickets++
    if (state.tickets[id]?.gone && state.tickets[id]?.savedFor === ticket.updatedAt) {
      counts.goneTickets++
      warnings.push(`ticket ${id} was deleted in Zendesk before its newest version could be saved`)
      continue
    }
    const folder = `tickets/${id}/${stamp(ticket.updatedAt)}`
    const versionMarker = markers.get(folder)
    if (!versionMarker || versionMarker.updatedAt !== ticket.updatedAt) {
      problems.push(`ticket ${id}: its newest version was not saved completely; run the backup again`)
      continue
    }
    const own = lists.get(folder) ?? new Map<string, Pages>()
    const required = ["comments", "audits"]
    if (versionMarker.sideConversations === "saved") {
      required.push("side_conversations", ...versionMarker.sideConversationIds.map((sideId) => `events:${sideId}`))
      counts.sideConversations += versionMarker.sideConversationIds.length
    } else {
      warnings.push(`ticket ${id}: side conversations could not be read when it was saved`)
    }
    for (const list of required) {
      const pages = own.get(list)
      const gap = pages ? listGap(pages) : "has no pages"
      if (gap) problems.push(`ticket ${id}: ${list} ${gap}`)
    }
    const tally = tallies.get(folder)
    counts.comments += tally?.comments ?? 0
    counts.internalNotes += tally?.internal ?? 0
  }

  // Collections: the newest run that read each one is complete, or says why it could not.
  for (const source of COLLECTION_SOURCES) {
    const runs = collections.get(source.name)
    const newest = runs ? [...runs.keys()].sort().at(-1) : undefined
    const pages = newest ? runs?.get(newest) : undefined
    if (!pages) problems.push(`the ${source.name} collection was never saved`)
    else if (pages === "unavailable") warnings.push(`the ${source.name} collection was not available to the token`)
    else {
      const gap = listGap(pages)
      if (gap) problems.push(`the ${source.name} collection ${gap}`)
    }
  }

  // Files: every file any saved version lists, and every file in the manifest.
  for (const id of expectedFiles.keys()) {
    if (!manifest.files[id]) problems.push(`file ${id} is listed in a saved page but not in manifest.json`)
  }
  for (const [id, entry] of Object.entries(manifest.files)) {
    if (entry.status === "failed") {
      counts.filesFailed++
      warnings.push(
        `file ${id} (ticket ${entry.ticketId}) could not be downloaded: ${entry.error ?? "no reason recorded"}`,
      )
      continue
    }
    if (!entry.sha256 || entry.bytes === undefined) {
      problems.push(`file ${id} is marked ok without a hash or size`)
      continue
    }
    if (entry.size !== null && entry.size !== entry.bytes) {
      problems.push(`file ${id}: Zendesk reported ${entry.size} bytes, the stored file has ${entry.bytes}`)
      continue
    }
    const actual = await hashFile(archive.filePath(entry.sha256)).catch(() => undefined)
    if (!actual) problems.push(`file ${id}: files/${entry.sha256.slice(0, 2)}/${entry.sha256} is missing`)
    else if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      problems.push(`file ${id}: its content does not match the recorded SHA-256 and size`)
    } else {
      counts.filesOk++
      if (expectedFiles.get(id)?.inline || entry.inline) counts.inlineImages++
    }
  }
  return result
}

/** raw-index.jsonl, read line by line; the last entry for a path wins. A damaged line is a problem. */
async function readIndex(path: string, problems: string[]): Promise<Map<string, RawIndexEntry>> {
  await stat(path)
  const index = new Map<string, RawIndexEntry>()
  const input = createReadStream(path, { encoding: "utf8" })
  let number = 0
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    number++
    if (!line) continue
    try {
      const entry = JSON.parse(line) as RawIndexEntry
      if (typeof entry.path !== "string" || typeof entry.sha256 !== "string") throw new Error("not an entry")
      index.set(entry.path, entry)
    } catch {
      problems.push(`${RAW_INDEX} line ${number} is damaged; a run that stopped mid-write is repaired by the next run`)
    }
  }
  return index
}

/**
 * Why a list's pages are incomplete, or null: pages 1 to N with no gap, every page but the last linking to a next
 * one, and the last linking to none.
 */
function listGap(pages: Pages): string | null {
  let last = 0
  for (const seq of pages.keys()) last = Math.max(last, seq)
  for (let seq = 1; seq <= last; seq++) {
    if (!pages.has(seq)) return `page ${seqName(seq)} is missing`
    if (seq < last && pages.get(seq) !== true) return `page ${seqName(seq)} ends the list before page ${seqName(last)}`
  }
  if (pages.get(last)) return "ends on a page that links to a next one"
  return null
}

function mapOf<K, V extends Map<unknown, unknown>>(outer: Map<K, V>, key: K): V {
  let inner = outer.get(key)
  if (!inner) {
    inner = new Map() as V
    outer.set(key, inner)
  }
  return inner
}

/** Adds every file under `dir`, relative to the raw folder, to `out`. Throws when a folder cannot be read. */
async function collectFiles(dir: string, prefix: string, out: string[]): Promise<void> {
  for await (const entry of await opendir(dir)) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) await collectFiles(join(dir, entry.name), relativePath, out)
    else if (entry.isFile()) out.push(relativePath)
  }
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256")
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer)
    bytes += (chunk as Buffer).byteLength
  }
  return { sha256: hash.digest("hex"), bytes }
}
