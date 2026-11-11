import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
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
 * - every export has its pages from the first to the last without a gap, and the ticket export reached its end;
 * - every ticket's newest version has all its comment, audit, and side conversation pages, the last one of each
 *   list without a next link;
 * - each collection's newest run is complete, or recorded as unavailable;
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

  const index = new Map<string, RawIndexEntry>()
  try {
    const lines = (await readFile(archive.path(RAW_INDEX), "utf8")).split("\n").filter(Boolean)
    for (const line of lines) {
      const entry = JSON.parse(line) as RawIndexEntry
      index.set(entry.path, entry)
    }
  } catch (error) {
    problems.push(`${RAW_INDEX} cannot be read: ${(error as Error).message}`)
    return result
  }

  let files: string[]
  try {
    files = await listFiles(archive.path("raw"))
  } catch (error) {
    problems.push(`raw/ cannot be read: ${(error as Error).message}`)
    return result
  }

  // What the pages say, kept small: no page body stays in memory.
  const exportPages = new Map<string, Map<number, boolean>>() // source -> seq -> end_of_stream
  const tickets = new Map<string, { updatedAt: string; status: string }>()
  const users = new Set<string>()
  const organizations = new Set<string>()
  const versions = new Map<string, Map<string, Pages>>() // "tickets/<id>/<version>" -> list -> pages
  const collections = new Map<string, Map<string, Pages | "unavailable">>() // name -> run -> pages
  const expectedFiles = new Map<string, { inline: boolean; ticketId: string }>()
  const latestComments = new Map<string, { comments: number; internal: number }>() // folder -> counts
  const present = new Set(files.map((f) => `raw/${f}`))

  for (const file of files) {
    const relativePath = `raw/${file}`
    // A temporary file a crash left behind; the page it would have become is checked by its own name.
    if (file.split("/").at(-1)?.startsWith(".tmp-")) continue
    let text: string
    try {
      text = await readFile(archive.path(relativePath), "utf8")
    } catch (error) {
      problems.push(`${relativePath} cannot be read: ${(error as Error).message}`)
      continue
    }
    if (file.endsWith("unavailable.json")) {
      const [, name, run] = /^collections\/([^/]+)\/([^/]+)\/unavailable\.json$/.exec(file) ?? []
      if (name && run) mapOf(collections, name).set(run, "unavailable")
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
    const ticketPage = /^(tickets\/(\d+)\/[^/]+)\/(comments|audits|side_conversations)-(\d+)\.json$/.exec(file)
    const eventsPage = /^(tickets\/(\d+)\/[^/]+)\/side_conversations\/([^/]+)\/events-(\d+)\.json$/.exec(file)
    const collectionPage = /^collections\/([^/]+)\/([^/]+)\/(\d+)\.json$/.exec(file)

    if (exportPage) {
      const [, source = "", seq = "0"] = exportPage
      mapOf(exportPages, source).set(Number(seq), page.end_of_stream === true)
      if (source === "tickets") {
        for (const t of (page.tickets ?? []) as { id: unknown; updated_at: string; status?: string }[]) {
          const id = String(t.id)
          const known = tickets.get(id)
          if (!known || known.updatedAt < t.updated_at)
            tickets.set(id, { updatedAt: t.updated_at, status: t.status ?? "" })
        }
      } else if (source === "users") {
        for (const u of (page.users ?? []) as { id: unknown }[]) users.add(String(u.id))
      } else if (source === "organizations") {
        for (const o of (page.organizations ?? []) as { id: unknown }[]) organizations.add(String(o.id))
      }
    } else if (ticketPage) {
      const [, folder = "", ticketId = "", list = "", seq = "0"] = ticketPage
      mapOf(mapOf(versions, folder), list).set(Number(seq), nextPage(json) !== null)
      if (list === "comments") {
        const tally = latestComments.get(folder) ?? { comments: 0, internal: 0 }
        for (const comment of (page.comments ?? []) as ZendeskComment[]) {
          tally.comments++
          if (comment.public === false) tally.internal++
          for (const a of comment.attachments ?? [])
            expectedFiles.set(String(a.id), { inline: a.inline === true, ticketId })
        }
        latestComments.set(folder, tally)
      }
    } else if (eventsPage) {
      const [, folder = "", ticketId = "", sideId = "", seq = "0"] = eventsPage
      mapOf(mapOf(versions, folder), `events:${sideId}`).set(Number(seq), nextPage(json) !== null)
      for (const event of (page.events ?? []) as ZendeskSideConversationEvent[]) {
        for (const a of event.message?.attachments ?? []) expectedFiles.set(String(a.id), { inline: false, ticketId })
      }
    } else if (collectionPage) {
      const [, name = "", run = "", seq = "0"] = collectionPage
      const runs = mapOf(collections, name)
      const pages = runs.get(run)
      const map = pages instanceof Map ? pages : new Map<number, boolean>()
      map.set(Number(seq), nextPage(json) !== null)
      runs.set(run, map)
    }
  }

  for (const path of index.keys()) {
    if (!present.has(path)) problems.push(`${path} is listed in ${RAW_INDEX} but missing`)
  }

  // Exports: every page from the first to the saved position, and the ticket export reached its end.
  for (const source of INCREMENTAL_SOURCES) {
    const position = state.exports[source.name]
    const pages = exportPages.get(source.name) ?? new Map()
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

  // Tickets: the newest version of each one has every page of every list.
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
    const lists = versions.get(folder)
    if (!lists?.has("comments") || !lists.has("audits")) {
      problems.push(`ticket ${id}: the comments or audits of its newest version are missing; run the backup again`)
      continue
    }
    for (const [list, pages] of lists) {
      const gap = listGap(pages)
      if (gap) problems.push(`ticket ${id}: ${list} ${gap}`)
    }
    const tally = latestComments.get(folder)
    counts.comments += tally?.comments ?? 0
    counts.internalNotes += tally?.internal ?? 0
    counts.sideConversations += [...lists.keys()].filter((k) => k.startsWith("events:")).length
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
  if (state.sideConversations === "unavailable") warnings.push("side conversations were not available to the token")

  // Files: every file any saved version lists, and every file in the manifest.
  for (const [id] of expectedFiles) {
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

/** Why a list's pages are incomplete, or null: pages 1 to N with no gap, and only the last without a next link. */
function listGap(pages: Pages): string | null {
  const last = Math.max(...pages.keys())
  for (let seq = 1; seq <= last; seq++) {
    if (!pages.has(seq)) return `page ${seqName(seq)} is missing`
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

/** Every file under `dir`, relative to it, sorted. Throws when a folder cannot be read. */
async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  await stat(dir)
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), relativePath)))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files.sort()
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
