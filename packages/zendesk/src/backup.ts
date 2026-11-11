import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises"
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
  VERSION_MARKER,
  type VersionMarker,
} from "./archive.ts"
import { temporaryName, type ZendeskClient, ZendeskError } from "./http.ts"
import {
  attachmentPath,
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
  /** Whether this run could read side conversations. */
  sideConversations: "available" | "unavailable" | "unknown"
  coveredUntil: string | null
}

/** The incremental export leaves out changes of the last minute. */
const EXPORT_DELAY_MS = 60_000

type Attachment = { commentId: string; attachment: ZendeskAttachment }

/** What this run learned about side conversations. Asked again on every run: an add-on can be added later. */
type RunState = { sideConversations: "available" | "unavailable" | "unknown" }

/**
 * One backup run. It continues where the previous run stopped: every page is written before the position moves
 * past it, and a ticket version counts as saved only once its marker records that every list and file was handled.
 * A run that stops part way is resumed by the next one.
 */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const { client, archive } = options
  const log = options.log ?? (() => {})
  const now = options.now ?? (() => new Date())

  const unlock = await archive.lock()
  try {
    // Read inside the lock: a run that waited cannot act on what another run changed meanwhile.
    const info = await archive.info()
    if (info) {
      if (info.format !== ARCHIVE_FORMAT || info.version !== ARCHIVE_VERSION) {
        throw new Error("the folder holds a different archive format")
      }
      if (info.apiOrigin !== client.apiOrigin) throw new Error("the archive belongs to another Zendesk account")
    } else {
      await archive.writeJson("archive.json", {
        format: ARCHIVE_FORMAT,
        version: ARCHIVE_VERSION,
        apiOrigin: client.apiOrigin,
        createdAt: now().toISOString(),
      })
    }
    await archive.repairRawIndex()
    const state = await archive.state()
    state.runs += 1
    await archive.saveState(state)
    const run = seqName(state.runs)
    const runState: RunState = { sideConversations: "unknown" }
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
        await archive.writeRaw(
          `raw/collections/${source.name}/${run}/unavailable.json`,
          JSON.stringify({ status: error.status, error: error.message }),
        )
        result.collectionsUnavailable.push(source.name)
        log(`${source.name}: not available (${error.status})`)
      }
    }

    const manifest = await archive.manifest()
    await reclaimLostFiles(archive, manifest)
    const attempted = new Set<string>()
    // A deleted ticket (listed as deleted, or gone after a 404, also in an archive from an earlier version of this tool)
    // may have pages saved by earlier runs, some by a run that stopped before it recorded their files: every file
    // they list gets a manifest entry, once. A run that stops in this loop does it again: recording is repeatable.
    let deleted = 0
    for (const [ticketId, ticket] of Object.entries(state.tickets)) {
      if ((ticket.status !== "deleted" && !ticket.gone) || ticket.filesRecorded) continue
      await recordSavedFiles(options, manifest, ticketId, attempted)
      if (ticket.status === "deleted") {
        ticket.gone = true
        ticket.savedFor = ticket.updatedAt
      }
      ticket.filesRecorded = true
      deleted++
    }
    if (deleted > 0) await archive.saveState(state)
    const pending = Object.entries(state.tickets)
      .filter(([, ticket]) => ticket.status !== "deleted" && ticket.savedFor !== ticket.updatedAt)
      .sort(([a], [b]) => Number(a) - Number(b))
    log(`tickets to save: ${pending.length}`)
    for (const [ticketId] of pending) {
      result.pages += await saveTicket(options, manifest, state, runState, ticketId, attempted)
      result.ticketsSaved++
      if (result.ticketsSaved % 50 === 0) log(`tickets saved: ${result.ticketsSaved} of ${pending.length}`)
    }

    result.pages += await backfillSideConversations(options, manifest, state, runState, attempted)

    // Files that failed before and were not tried in this run. A comment attachment gets a fresh link from Show
    // Attachment first; the saved pages of its ticket stay as they are.
    for (const entry of Object.values(manifest.files)) {
      if (entry.status !== "failed" || attempted.has(entry.attachmentId)) continue
      attempted.add(entry.attachmentId)
      if (!entry.commentId.startsWith("side:") && isTicketId(entry.attachmentId)) {
        try {
          const page = await client.getJson(attachmentPath(entry.attachmentId))
          const fresh = (page.json as { attachment?: ZendeskAttachment }).attachment
          if (fresh?.content_url) entry.contentUrl = fresh.content_url
          if (typeof fresh?.size === "number") entry.size = fresh.size
        } catch (error) {
          if (!(error instanceof ZendeskError)) throw error
          entry.error = `no fresh link: ${error.message}`
        }
      }
      if (entry.contentUrl) await fetchFile(options, entry, now)
      await archive.saveManifest(manifest)
    }

    for (const entry of Object.values(manifest.files)) {
      if (entry.status === "ok") result.filesSaved++
      else result.filesFailed++
    }
    result.sideConversations = runState.sideConversations
    await archive.writeJson(`runs/${run}.json`, { ...result, finishedAt: now().toISOString() })
    log(`run ${state.runs} done: ${result.ticketsSaved} tickets saved, ${result.filesFailed} files failed`)
    return result
  } finally {
    await unlock()
  }
}

/** A file marked ok whose content is gone or the wrong size (a crash before the disk kept it) is fetched again. */
async function reclaimLostFiles(archive: Archive, manifest: Manifest): Promise<void> {
  let changed = false
  for (const entry of Object.values(manifest.files)) {
    if (entry.status !== "ok" || !entry.sha256) continue
    const size = await stat(archive.filePath(entry.sha256)).then(
      (s) => s.size,
      () => -1,
    )
    if (size === entry.bytes) continue
    entry.status = "failed"
    entry.error = "the stored file was missing or incomplete; fetching it again"
    changed = true
  }
  if (changed) await archive.saveManifest(manifest)
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
      ...(known?.filesRecorded ? { filesRecorded: true } : {}),
      // The export returns a ticket again for system updates that keep its updated_at: the saved version still lacks
      // its side conversations.
      ...(known?.sideConversationsMissing ? { sideConversationsMissing: true } : {}),
    }
  }
}

/**
 * Saves one ticket's comments, audits, side conversations, and files for its newest version, then writes the
 * version's marker. Returns the pages read.
 */
async function saveTicket(
  options: BackupOptions,
  manifest: Manifest,
  state: ArchiveState,
  runState: RunState,
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
  let gone = false
  let sides: { status: "saved" | "unavailable"; ids: string[] } = { status: "unavailable", ids: [] }
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
    if (!(error instanceof ZendeskError) || error.status !== 404) throw error
    gone = true
  }
  if (!gone) {
    const saved = await saveSideConversations(options, runState, ticketId, folder, attachments)
    if (saved === "gone") gone = true
    else {
      pages += saved.pages
      sides = saved
    }
  }

  // Every file a saved page lists gets a manifest entry, also for a ticket deleted while it was saved: downloaded, or
  // failed with the reason.
  await recordFiles(options, manifest, ticketId, attachments, attempted)
  if (gone) {
    // Pages of earlier, interrupted runs of this ticket list files too.
    await recordSavedFiles(options, manifest, ticketId, attempted)
    return markGone(options, state, ticketId, pages)
  }
  await writeMarker(archive, folder, ticket.updatedAt, sides, now)
  ticket.savedFor = ticket.updatedAt
  // A ticket restored in Zendesk after a 404 is saved again like any other.
  delete ticket.gone
  delete ticket.filesRecorded
  ticket.sideConversationsMissing = sides.status === "unavailable" ? true : undefined
  await archive.saveState(state)
  return pages
}

async function writeMarker(
  archive: Archive,
  folder: string,
  updatedAt: string,
  sides: { status: "saved" | "unavailable"; ids: string[] },
  now: () => Date,
) {
  const marker: VersionMarker = {
    updatedAt,
    sideConversations: sides.status,
    sideConversationIds: sides.ids,
    savedAt: now().toISOString(),
  }
  await archive.writeRaw(`${folder}/${VERSION_MARKER}`, JSON.stringify(marker))
}

/** Gives every listed file a manifest entry and tries to download those not saved yet. */
async function recordFiles(
  options: BackupOptions,
  manifest: Manifest,
  ticketId: string,
  attachments: Attachment[],
  attempted: Set<string>,
): Promise<void> {
  const now = options.now ?? (() => new Date())
  for (const { commentId, attachment } of attachments) {
    const id = String(attachment.id)
    const existing = manifest.files[id]
    if (existing?.status === "ok" || attempted.has(id)) continue
    const entry: ManifestEntry = {
      attachmentId: id,
      ticketId,
      commentId,
      // Comment attachments name the file `file_name`; side conversation attachments `name`.
      fileName: attachment.file_name ?? attachment.name ?? "",
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
  await options.archive.saveManifest(manifest)
}

/**
 * Records the files that the saved pages of every version of a deleted ticket list, also pages of a run that stopped
 * before it recorded them. Files already saved are skipped.
 */
async function recordSavedFiles(
  options: BackupOptions,
  manifest: Manifest,
  ticketId: string,
  attempted: Set<string>,
): Promise<void> {
  const folder = `raw/tickets/${ticketId}`
  const versions = await list(options.archive.path(folder), "folders")
  const attachments: Attachment[] = []
  for (const version of versions)
    attachments.push(...(await attachmentsOnDisk(options.archive, `${folder}/${version}`)))
  if (attachments.length > 0) await recordFiles(options, manifest, ticketId, attachments, attempted)
}

/**
 * The folders or the files in a folder; none when it does not exist. Any other error (no permission, a failing disk)
 * stops the run, so a folder that could not be read is never taken for an empty one.
 */
async function list(path: string, kind: "folders" | "files"): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries.filter((e) => (kind === "folders" ? e.isDirectory() : e.isFile())).map((e) => e.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

/** The files listed in pages already saved in a version folder: comment pages and side conversation events. */
async function attachmentsOnDisk(archive: Archive, folder: string): Promise<Attachment[]> {
  const found: Attachment[] = []
  const read = async (path: string) => JSON.parse(await readFile(archive.path(path), "utf8")) as unknown
  const names = await list(archive.path(folder), "files")
  for (const name of names.filter((n) => /^comments-\d+\.json$/.test(n))) {
    const page = (await read(`${folder}/${name}`)) as { comments?: ZendeskComment[] }
    for (const comment of page.comments ?? []) {
      for (const attachment of comment.attachments ?? []) found.push({ commentId: String(comment.id), attachment })
    }
  }
  const sideIds = await list(archive.path(folder, "side_conversations"), "folders")
  for (const sideId of sideIds) {
    for (const name of await list(archive.path(folder, "side_conversations", sideId), "files")) {
      if (!/^events-\d+\.json$/.test(name)) continue
      const page = (await read(`${folder}/side_conversations/${sideId}/${name}`)) as {
        events?: ZendeskSideConversationEvent[]
      }
      for (const event of page.events ?? []) {
        for (const attachment of event.message?.attachments ?? []) {
          found.push({ commentId: `side:${String(event.id)}`, attachment })
        }
      }
    }
  }
  return found
}

/**
 * Tickets saved while side conversations could not be read get them once a run can read them: the lists go into the
 * same version folder, where they were missing, and the marker is written again. No saved page is replaced.
 */
async function backfillSideConversations(
  options: BackupOptions,
  manifest: Manifest,
  state: ArchiveState,
  runState: RunState,
  attempted: Set<string>,
): Promise<number> {
  const now = options.now ?? (() => new Date())
  let pages = 0
  for (const [ticketId, ticket] of Object.entries(state.tickets)) {
    if (!ticket.sideConversationsMissing || ticket.gone || ticket.status === "deleted") continue
    if (ticket.savedFor !== ticket.updatedAt) continue
    if (runState.sideConversations === "unavailable") break
    const folder = `raw/tickets/${ticketId}/${stamp(ticket.updatedAt)}`
    const attachments: Attachment[] = []
    const saved = await saveSideConversations(options, runState, ticketId, folder, attachments)
    if (saved === "gone") {
      await recordSavedFiles(options, manifest, ticketId, attempted)
      await markGone(options, state, ticketId, 0)
      continue
    }
    if (saved.status === "unavailable") break
    pages += saved.pages
    await recordFiles(options, manifest, ticketId, attachments, attempted)
    await writeMarker(options.archive, folder, ticket.updatedAt, saved, now)
    ticket.sideConversationsMissing = undefined
    await options.archive.saveState(state)
  }
  return pages
}

async function markGone(options: BackupOptions, state: ArchiveState, ticketId: string, pages: number) {
  const ticket = state.tickets[ticketId]
  if (!ticket) return pages
  options.log?.(`ticket ${ticketId}: gone (404); kept what was saved before`)
  ticket.gone = true
  // Every caller records the files of the saved pages first.
  ticket.filesRecorded = true
  ticket.savedFor = ticket.updatedAt
  await options.archive.saveState(state)
  return pages
}

/**
 * Side conversations (an add-on): the list of a ticket's side conversations and each one's events, which hold the
 * messages and their attachments. A 403 means the account or token cannot read them in this run; a 404 is checked
 * against the ticket itself, so a ticket deleted meanwhile never turns side conversations off for the others.
 */
async function saveSideConversations(
  options: BackupOptions,
  runState: RunState,
  ticketId: string,
  folder: string,
  attachments: Attachment[],
): Promise<{ status: "saved" | "unavailable"; ids: string[]; pages: number } | "gone"> {
  const { client, archive } = options
  if (runState.sideConversations === "unavailable") return { status: "unavailable", ids: [], pages: 0 }
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
    if (!(error instanceof ZendeskError) || (error.status !== 403 && error.status !== 404)) throw error
    if (error.status === 404) {
      // Is the ticket itself gone, or only the add-on missing?
      const ticketGone = await client.getJson(`/api/v2/tickets/${ticketId}.json`).then(
        () => false,
        (e: unknown) => e instanceof ZendeskError && e.status === 404,
      )
      if (ticketGone) return "gone"
    }
    runState.sideConversations = "unavailable"
    options.log?.(`side conversations: not available in this run (${error.status})`)
    return { status: "unavailable", ids: [], pages }
  }
  runState.sideConversations = "available"
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
  return { status: "saved", ids, pages }
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
    // A copy already there with the right size is the same content (named by its SHA-256); one with another size is
    // damaged and is replaced by this verified download.
    const existingSize = await stat(target).then(
      (s) => s.size,
      () => -1,
    )
    if (existingSize === download.bytes) await rm(partial, { force: true })
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
