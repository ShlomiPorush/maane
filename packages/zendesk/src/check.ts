import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, Archive, type ArchiveState, type Manifest, stamp } from "./archive.ts"
import type { ZendeskComment } from "./sources.ts"

export interface CheckCounts {
  jsonFiles: number
  tickets: number
  deletedTickets: number
  goneTickets: number
  comments: number
  internalNotes: number
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

/**
 * Reads the whole archive without any access to Zendesk: every JSON file parses, every ticket's newest
 * version has its comments and audits, every file a comment lists is either stored with a matching SHA-256
 * and size or recorded as an explicit failure.
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
  if (!state.exports.tickets?.caughtUp) problems.push("the ticket export never reached the end of the stream")

  // Every JSON file under raw/ must parse.
  const parsed = new Map<string, unknown>()
  for (const file of await listFiles(archive.path("raw"))) {
    if (!file.endsWith(".json")) continue
    try {
      parsed.set(file, JSON.parse(await readFile(archive.path("raw", file), "utf8")))
      counts.jsonFiles++
    } catch {
      problems.push(`raw/${file} is not valid JSON`)
    }
  }

  // The newest version of each ticket, from the export pages themselves.
  const tickets = new Map<string, { updatedAt: string; status: string }>()
  const users = new Set<string>()
  const organizations = new Set<string>()
  for (const [file, body] of parsed) {
    const page = body as Record<string, unknown>
    if (file.startsWith("incremental/tickets/")) {
      for (const t of (page.tickets ?? []) as { id: unknown; updated_at: string; status?: string }[]) {
        const id = String(t.id)
        const known = tickets.get(id)
        if (!known || known.updatedAt < t.updated_at)
          tickets.set(id, { updatedAt: t.updated_at, status: t.status ?? "" })
      }
    } else if (file.startsWith("incremental/users/")) {
      for (const u of (page.users ?? []) as { id: unknown }[]) users.add(String(u.id))
    } else if (file.startsWith("incremental/organizations/")) {
      for (const o of (page.organizations ?? []) as { id: unknown }[]) organizations.add(String(o.id))
    }
  }
  counts.users = users.size
  counts.organizations = organizations.size

  // The saved pages of each ticket version, by folder: tickets/<id>/<version>/.
  const byFolder = new Map<string, string[]>()
  for (const file of parsed.keys()) {
    if (!file.startsWith("tickets/")) continue
    const folder = file.slice(0, file.lastIndexOf("/") + 1)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), file])
  }

  const expectedFiles = new Map<string, { inline: boolean }>()
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
    const folder = `tickets/${id}/${stamp(ticket.updatedAt)}/`
    const own = byFolder.get(folder) ?? []
    const commentPages = own.filter((file) => file.slice(folder.length).startsWith("comments-"))
    const auditPages = own.filter((file) => file.slice(folder.length).startsWith("audits-"))
    if (commentPages.length === 0 || auditPages.length === 0) {
      problems.push(`ticket ${id}: the comments or audits of its newest version are missing; run the backup again`)
      continue
    }
    for (const file of commentPages) {
      for (const comment of ((parsed.get(file) as { comments?: ZendeskComment[] }).comments ??
        []) as ZendeskComment[]) {
        counts.comments++
        if (comment.public === false) counts.internalNotes++
        for (const attachment of comment.attachments ?? []) {
          expectedFiles.set(String(attachment.id), { inline: attachment.inline === true })
        }
      }
    }
  }

  for (const [id, expected] of expectedFiles) {
    const entry = manifest.files[id]
    if (!entry) {
      problems.push(`file ${id} is listed in a comment but not in manifest.json`)
      continue
    }
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
    const actual = await hashFile(archive.filePath(entry.sha256)).catch(() => undefined)
    if (!actual) problems.push(`file ${id}: files/${entry.sha256.slice(0, 2)}/${entry.sha256} is missing`)
    else if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes) {
      problems.push(`file ${id}: its content does not match the recorded SHA-256 and size`)
    } else {
      counts.filesOk++
      if (expected.inline) counts.inlineImages++
      if (entry.size !== null && entry.size !== entry.bytes) {
        warnings.push(`file ${id}: Zendesk reported ${entry.size} bytes, the download has ${entry.bytes}`)
      }
    }
  }
  return result
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  let entries: import("node:fs").Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...(await listFiles(join(dir, entry.name), relative)))
    else if (entry.isFile()) files.push(relative)
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
