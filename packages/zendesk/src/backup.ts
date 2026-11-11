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
  isSafeId,
  isTicketId,
  MAX_PAGES,
  nextPage,
  PAGE_SIZE,
  sideConversationEventsPath,
  sideConversationsPath,
  type ZendeskAttachment,
  type ZendeskComment,
  type ZendeskSideConversationEvent,
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
  /** Collections the account answered 403 or 404 for, with the reason in their unavailable.json. */
  collectionsUnavailable: string[]
  sideConversations: "available" | "unavailable" | "unknown"
  coveredUntil: string | null
}

/** The incremental export leaves out changes of the last minute. */
const EXPORT_DELAY_MS = 60_000

type Attachment = { commentId: string; attachment: ZendeskAttachment }

/**
 * One backup run. It continues where the previous run stopped: every page is written before the position moves
 * past it, and every ticket's comments, audits, side conversations, and files before the ticket counts as saved.
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
      collectionsUnavailable: [],
      sideConversations: "unknown",
      coveredUntil: state.coveredUntil,
    }

    for (const source of INCREMENTAL_SOURCES) {
      result.pages += await exportIncremental(options, state, source)
    }
    result.coveredUntil = state.coveredUntil

    for (const source of COLLECTION_SOURCES) {
      const first = source.paged ? `${source.path}?page[size]=${PAGE_SIZE}` : source.path
      try {
        result.pages += await fetchList(client, first, (seq, text) =>
          archive.writeRaw(`raw/collections/${source.name}/${run}/${seqName(seq)}.json`, text),
        )
        log(`${source.name}: saved`)
      } catch (error) {
        // An account without the feature or a token without the right answers 403 or 404. The collection is
        // settings, not customer data: record why it is missing and go on.
        if (!(error instanceof ZendeskError) || (error.status !== 403 && error.status !== 404)) throw error
        await archive.writeJson(`raw/collections/${source.name}/${run}/unavailable.json`, {
          status: error.status,
          error: error.message,
        })
        result.collectionsUnavailable.push(source.name)
        log(`${source.name}: not available (${error.status})`)
      }
    }

    const manifest = await archive.manifest()
    const pending = Object.entries(state.tickets)
      .filter(([, ticket]) => ticket.status !== "deleted" && ticket.savedFor !== ticket.updatedAt)
      .sort(([a], [b]) => Number(a) - Number(b))
    log(`tickets to save: ${pending.length}`)
    const attempted = new Set<string>()
    for (const [ticketId] of pending) {
      result.pages += await saveTicket(options, manifest, state, ticketId, attempted)
      result.ticketsSaved++
      if (result.ticketsSaved % 50 === 0) log(`tickets saved: ${result.ticketsSaved} of ${pending.length}`)
    }

    // Files that failed on an earlier run: read their ticket again first, which gives fresh download links, then try
    // any file still failed and not tried in this run with the link it has.
    const failedTickets = new Set(
      Object.values(manifest.files)
        .filter((entry) => entry.status === "failed" && !attempted.has(entry.attachmentId))
        .map((entry) => entry.ticketId),
    )
    for (const ticketId of failedTickets) {
      const ticket = state.tickets[ticketId]
      if (!ticket || ticket.status === "deleted" || ticket.gone) continue
      result.pages += await saveTicket(options, manifest, state, ticketId, attempted)
    }
    for (const entry of Object.values(manifest.files)) {
      if (entry.status === "failed" && !attempted.has(entry.attachmentId) && entry.contentUrl) {
        attempted.add(entry.attachmentId)
        await fetchFile(options, entry, now)
        await archive.saveManifest(manifest)
      }
    }

    for (const entry of Object.values(manifest.files)) {
      if (entry.status === "ok") result.filesSaved++
      else result.filesFailed++
    }
    result.sideConversations = state.sideConversations ?? "unknown"
    await archive.writeJson(`runs/${run}.json`, { ...result, finishedAt: now().toISOString() })
    log(`run ${state.runs} done: ${result.ticketsSaved} tickets saved, ${result.filesFailed} files failed`)
    return result
  } finally {
    await unlock()
  }
}

/**
 * Reads a list from its first page to its last, writing each page with `write(seq, text)` as soon as it arrives.
 * Stops the run on a link that repeats or a list longer than MAX_PAGES.
 */
async function fetchList(
  client: ZendeskClient,
  first: string,
  write: (seq: number, text: string) => Promise<void>,
  onPage?: (json: unknown) => void,
): Promise<number> {
  const seen = new Set<string>()
  let url: string | null = first
  let seq = 0
  while (url) {
    if (seen.has(url) || seq >= MAX_PAGES) throw new ZendeskError("a list whose next-page link repeats or never ends")
    seen.add(url)
    seq++
    const page = await client.getJson(url)
    await write(seq, page.text)
    onPage?.(page.json)
    url = nextPage(page.json)
  }
  return seq
}

async function exportIncremental(options: BackupOptions, state: ArchiveState, source: IncrementalSource) {
  const { client, archive } = options
  const position: ExportPosition = state.exports[source.name] ?? { seq: 1, caughtUp: false }
  state.exports[source.name] = position
  const extra = source.query ? `&${source.query}` : ""
  let pages = 0
  for (;;) {
    if (pages >= MAX_PAGES) throw new ZendeskError(`${source.name}: an export that never reaches its end`)
    const url =
      source.kind === "cursor"
        ? position.cursor
          ? `${source.path}?cursor=${encodeURIComponent(position.cursor)}${extra}`
          : `${source.path}?start_time=0${extra}`
        : `${source.path}?start_time=${position.startTime ?? 0}${extra}`
    const page = await client.getJson(url)
    const body = page.json as Record<string, unknown>
    // The page is on disk before the position moves past it. A crash in between fetches it again into the same file.
    await archive.writeRaw(`raw/incremental/${source.name}/${seqName(position.seq)}.json`, page.text)
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
        state.coveredUntil = page.serverDate
          ? new Date(page.serverDate.getTime() - EXPORT_DELAY_MS).toISOString()
          : null
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
    // The ID becomes a folder name: anything but digits stops the run rather than write outside the archive.
    if (!isTicketId(id)) throw new ZendeskError("tickets: a ticket ID that is not a number")
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

/** Saves one ticket's comments, audits, side conversations, and files for its newest version. Returns the pages. */
async function saveTicket(
  options: BackupOptions,
  manifest: Manifest,
  state: ArchiveState,
  ticketId: string,
  attempted: Set<string>,
): Promise<number> {
  const { client, archive } = options
  const now = options.now ?? (() => new Date())
  const ticket = state.tickets[ticketId]
  if (!ticket) return 0
  if (!isTicketId(ticketId)) throw new ZendeskError("a ticket ID that is not a number")
  const folder = `raw/tickets/${ticketId}/${stamp(ticket.updatedAt)}`
  let pages = 0
  const attachments: Attachment[] = []
  try {
    pages += await fetchList(
      client,
      commentsPath(ticketId),
      (seq, text) => archive.writeRaw(`${folder}/comments-${seqName(seq)}.json`, text),
      (json) => {
        for (const comment of ((json as { comments?: ZendeskComment[] }).comments ?? []) as ZendeskComment[]) {
          for (const attachment of comment.attachments ?? []) {
            attachments.push({ commentId: String(comment.id), attachment })
          }
        }
      },
    )
    pages += await fetchList(client, auditsPath(ticketId), (seq, text) =>
      archive.writeRaw(`${folder}/audits-${seqName(seq)}.json`, text),
    )
  } catch (error) {
    // A ticket deleted after the export listed it answers 404. Its earlier versions, if any, stay saved.
    if (error instanceof ZendeskError && error.status === 404) {
      options.log?.(`ticket ${ticketId}: gone (404); kept what was saved before`)
      ticket.gone = true
      ticket.savedFor = ticket.updatedAt
      await archive.saveState(state)
      return pages
    }
    throw error
  }
  pages += await saveSideConversations(options, state, ticketId, folder, attachments)

  for (const { commentId, attachment } of attachments) {
    const id = String(attachment.id)
    const existing = manifest.files[id]
    if (existing?.status === "ok") continue
    const entry: ManifestEntry = {
      attachmentId: id,
      ticketId,
      commentId,
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
    attempted.add(id)
    await fetchFile(options, entry, now)
  }
  await archive.saveManifest(manifest)
  ticket.savedFor = ticket.updatedAt
  await archive.saveState(state)
  return pages
}

/**
 * Side conversations (an add-on): the list of a ticket's side conversations and each one's events, which hold the
 * messages and their attachments. An account without the add-on answers 403 or 404 once; the run then skips them.
 */
async function saveSideConversations(
  options: BackupOptions,
  state: ArchiveState,
  ticketId: string,
  folder: string,
  attachments: Attachment[],
): Promise<number> {
  const { client, archive } = options
  if (state.sideConversations === "unavailable") return 0
  const ids: string[] = []
  let pages = 0
  try {
    pages += await fetchList(
      client,
      sideConversationsPath(ticketId),
      (seq, text) => archive.writeRaw(`${folder}/side_conversations-${seqName(seq)}.json`, text),
      (json) => {
        for (const item of (json as { side_conversations?: { id?: unknown }[] }).side_conversations ?? []) {
          ids.push(String(item.id))
        }
      },
    )
  } catch (error) {
    if (error instanceof ZendeskError && (error.status === 403 || error.status === 404)) {
      state.sideConversations = "unavailable"
      await archive.saveState(state)
      options.log?.(`side conversations: not available (${error.status})`)
      return pages
    }
    throw error
  }
  state.sideConversations = "available"
  for (const id of ids) {
    if (!isSafeId(id)) throw new ZendeskError("a side conversation ID with unexpected characters")
    pages += await fetchList(
      client,
      sideConversationEventsPath(ticketId, id),
      (seq, text) => archive.writeRaw(`${folder}/side_conversations/${id}/events-${seqName(seq)}.json`, text),
      (json) => {
        for (const event of (json as { events?: ZendeskSideConversationEvent[] }).events ?? []) {
          for (const attachment of event.message?.attachments ?? []) {
            attachments.push({ commentId: `side:${String(event.id)}`, attachment })
          }
        }
      },
    )
  }
  return pages
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
    const download = await client.download(entry.contentUrl, partial, options.maxFileBytes, entry.size)
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
