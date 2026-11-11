import { mkdir, rename, rm, stat } from "node:fs/promises"
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  type Archive,
  type ArchiveState,
  type ExportPosition,
  type Manifest,
  type ManifestEntry,
  seqName,
  stamp,
} from "./archive.ts"
import { temporaryName, type ZendeskClient, ZendeskError } from "./http.ts"
import {
  auditsPath,
  COLLECTION_SOURCES,
  commentsPath,
  INCREMENTAL_SOURCES,
  type IncrementalSource,
  nextPage,
  PAGE_SIZE,
  type ZendeskAttachment,
  type ZendeskComment,
} from "./sources.ts"

export interface BackupOptions {
  client: ZendeskClient
  archive: Archive
  /** Largest file to download, in bytes. Larger files are recorded as failed. */
  maxFileBytes: number
  log?: (line: string) => void
  now?: () => Date
}

export interface BackupResult {
  run: number
  pages: number
  ticketsSaved: number
  filesSaved: number
  filesFailed: number
  coveredUntil: string | null
}

/** Failed downloads are tried again on later runs, up to this many attempts in all. */
const MAX_FILE_ATTEMPTS = 5

/** The incremental export leaves out changes of the last minute. */
const EXPORT_DELAY_MS = 60_000

/**
 * One backup run. It continues where the previous run stopped: every page is written before the position
 * moves past it, and every ticket's comments, audits and files before the ticket counts as saved.
 * A run that stops part way is resumed by the next one.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const { client, archive } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => new Date())

  const info = await archive.info()
  if (info) {
    if (info.format !== ARCHIVE_FORMAT || info.version !== ARCHIVE_VERSION) {
      throw new Error("the folder holds a different archive format")
    }
    if (info.apiOrigin !== client.apiOrigin) throw new Error("the archive belongs to another Zendesk account")
  }

  const unlock = await archive.lock()
  try {
    if (!info) {
      await archive.writeJson("archive.json", {
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        apiOrigin: client.apiOrigin,
        createdAt: now().toISOString(),
      })
    }
    const state = await archive.state()
    state.runs += 1
    await archive.saveState(state)
    const run = seqName(state.runs)
    const result: BackupResult = {
      run: state.runs,
      pages: 0,
      ticketsSaved: 0,
      filesSaved: 0,
      filesFailed: 0,
      coveredUntil: state.coveredUntil,
    }

    for (const source of INCREMENTAL_SOURCES) {
      result.pages += await exportIncremental(options, state, source, now)
    }
    result.coveredUntil = state.coveredUntil

    for (const source of COLLECTION_SOURCES) {
      let url: string | null = source.paged ? `${source.path}?page[size]=${PAGE_SIZE}` : source.path
      for (let seq = 1; url; seq++) {
        const page = await client.getJson(url)
        await archive.write(`raw/collections/${source.name}/${run}/${seqName(seq)}.json`, page.text)
        result.pages++
        url = nextPage(page.json)
      }
      log(`${source.name}: saved`)
    }

    const manifest = await archive.manifest()
    const pending = Object.entries(state.tickets)
      .filter(([, ticket]) => ticket.status !== "deleted" && ticket.savedFor !== ticket.updatedAt)
      .sort(([a], [b]) => Number(a) - Number(b))
    log(`tickets to save: ${pending.length}`)
    for (const [ticketId] of pending) {
      const saved = await saveTicket(options, manifest, state, ticketId, now)
      result.pages += saved.pages
      result.ticketsSaved++
      if (result.ticketsSaved % 50 === 0) log(`tickets saved: ${result.ticketsSaved} of ${pending.length}`)
    }

    for (const entry of Object.values(manifest.files)) {
      if (entry.status === "failed" && entry.contentUrl && entry.attempts < MAX_FILE_ATTEMPTS) {
        await fetchFile(options, entry, now)
        await archive.saveManifest(manifest)
      }
    }

    for (const entry of Object.values(manifest.files)) {
      if (entry.status === "ok") result.filesSaved++
      else result.filesFailed++
    }
    await archive.writeJson(`runs/${run}.json`, { ...result, finishedAt: now().toISOString() })
    log(`run ${state.runs} done: ${result.ticketsSaved} tickets saved, ${result.filesFailed} files failed`)
    return result
  } finally {
    await unlock()
  }
}

async function exportIncremental(
  options: BackupOptions,
  state: ArchiveState,
  source: IncrementalSource,
  now: () => Date,
): Promise<number> {
  const { client, archive } = options
  const position: ExportPosition = state.exports[source.name] ?? { seq: 1, caughtUp: false }
  state.exports[source.name] = position
  let pages = 0
  for (;;) {
    const url =
      source.kind === "cursor"
        ? position.cursor
          ? `${source.path}?cursor=${encodeURIComponent(position.cursor)}`
          : `${source.path}?start_time=0`
        : `${source.path}?start_time=${position.startTime ?? 0}`
    const requestedAt = now()
    const page = await client.getJson(url)
    const body = page.json as Record<string, unknown>
    // The page is on disk before the position moves past it. A crash in between fetches it again into
    // the same file.
    await archive.write(`raw/incremental/${source.name}/${seqName(position.seq)}.json`, page.text)
    pages++

    if (source.name === "tickets") recordTickets(state, body[source.key])
    const end = body.end_of_stream === true
    if (source.kind === "cursor") {
      const cursor = body.after_cursor
      if (typeof cursor === "string" && cursor) position.cursor = cursor
      else if (!end) throw new ZendeskError(`${source.name}: a page without a cursor before the end of the stream`)
    } else {
      const endTime = body.end_time
      if (typeof endTime === "number") position.startTime = endTime
      else if (!end) throw new ZendeskError(`${source.name}: a page without an end time before the end of the stream`)
    }
    position.seq++
    if (end) {
      position.caughtUp = true
      if (source.name === "tickets") {
        state.coveredUntil = new Date(requestedAt.getTime() - EXPORT_DELAY_MS).toISOString()
      }
    }
    await archive.saveState(state)
    if (end) {
      options.log?.(`${source.name}: up to date (${pages} pages this run)`)
      return pages
    }
  }
}

function recordTickets(state: ArchiveState, records: unknown): void {
  if (!Array.isArray(records)) throw new ZendeskError("tickets: a page without a ticket list")
  for (const record of records as { id?: unknown; updated_at?: unknown; status?: unknown }[]) {
    if (record.id === undefined || typeof record.updated_at !== "string") continue
    const id = String(record.id)
    const known = state.tickets[id]
    if (known && known.updatedAt > record.updated_at) continue
    state.tickets[id] = {
      updatedAt: record.updated_at,
      status: typeof record.status === "string" ? record.status : "unknown",
      savedFor: known?.savedFor ?? null,
      ...(known?.gone ? { gone: known.gone } : {}),
    }
  }
}

/** Saves one ticket's comments, audits and files for its newest version. */
async function saveTicket(
  options: BackupOptions,
  manifest: Manifest,
  state: ArchiveState,
  ticketId: string,
  now: () => Date,
): Promise<{ pages: number }> {
  const { client, archive } = options
  const ticket = state.tickets[ticketId]
  if (!ticket) return { pages: 0 }
  const folder = `raw/tickets/${ticketId}/${stamp(ticket.updatedAt)}`
  let pages = 0
  const attachments: { comment: ZendeskComment; attachment: ZendeskAttachment }[] = []
  try {
    for (const [kind, first] of [
      ["comments", commentsPath(ticketId)],
      ["audits", auditsPath(ticketId)],
    ] as const) {
      let url: string | null = first
      for (let seq = 1; url; seq++) {
        const page = await client.getJson(url)
        await archive.write(`${folder}/${kind}-${seqName(seq)}.json`, page.text)
        pages++
        if (kind === "comments") {
          for (const comment of ((page.json as { comments?: ZendeskComment[] }).comments ?? []) as ZendeskComment[]) {
            for (const attachment of comment.attachments ?? []) attachments.push({ comment, attachment })
          }
        }
        url = nextPage(page.json)
      }
    }
  } catch (error) {
    // A ticket deleted after the export listed it answers 404. Its earlier versions, if any, stay saved.
    if (error instanceof ZendeskError && error.status === 404) {
      options.log?.(`ticket ${ticketId}: gone (404); kept what was saved before`)
      ticket.gone = true
      ticket.savedFor = ticket.updatedAt
      await archive.saveState(state)
      return { pages }
    }
    throw error
  }

  for (const { comment, attachment } of attachments) {
    const id = String(attachment.id)
    const existing = manifest.files[id]
    if (existing?.status === "ok") continue
    const entry: ManifestEntry = {
      attachmentId: id,
      ticketId,
      commentId: String(comment.id),
      fileName: attachment.file_name ?? "",
      contentType: attachment.content_type ?? null,
      inline: attachment.inline === true,
      size: typeof attachment.size === "number" ? attachment.size : null,
      contentUrl: attachment.content_url ?? null,
      status: "failed",
      attempts: existing?.attempts ?? 0,
      updatedAt: now().toISOString(),
    }
    manifest.files[id] = entry
    await fetchFile(options, entry, now)
  }
  await archive.saveManifest(manifest)
  ticket.savedFor = ticket.updatedAt
  await archive.saveState(state)
  return { pages }
}

/** Downloads one file into files/, content-addressed, and records the outcome on the entry. */
async function fetchFile(options: BackupOptions, entry: ManifestEntry, now: () => Date): Promise<void> {
  const { client, archive } = options
  entry.attempts++
  entry.updatedAt = now().toISOString()
  if (!entry.contentUrl) {
    entry.status = "failed"
    entry.error = "Zendesk lists no content URL for this file"
    return
  }
  const partial = archive.path("files", temporaryName())
  await mkdir(archive.path("files"), { recursive: true })
  try {
    const download = await client.download(entry.contentUrl, partial, options.maxFileBytes)
    const target = archive.filePath(download.sha256)
    await mkdir(archive.path("files", download.sha256.slice(0, 2)), { recursive: true })
    if (await exists(target)) await rm(partial, { force: true })
    else await rename(partial, target)
    entry.status = "ok"
    entry.sha256 = download.sha256
    entry.bytes = download.bytes
    delete entry.error
  } catch (error) {
    await rm(partial, { force: true })
    if (!(error instanceof ZendeskError)) throw error
    entry.status = "failed"
    entry.error = error.message
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
