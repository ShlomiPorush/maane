import { readdir, readFile, stat } from "node:fs/promises"
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, Archive, type ArchiveInfo, type ArchiveState, stamp } from "./archive.ts"
import type { ZendeskAttachment } from "./sources.ts"

// Reads what the import needs from an archive the backup tool wrote, without any access to Zendesk (plan 5.1): the
// newest version of each ticket from the ticket export, its saved comments, audits, and side conversations, the users,
// and the newest complete run of a collection. Only the import reads it; the strict check (check.ts) runs first. The
// field names follow Zendesk's API reference (tickets, ticket comments, the via object, users, ticket fields); anything
// missing or of another shape reads as absent, never as an error.

/** The via object (Zendesk's "Via object reference"): `source.rel` is `follow_up` or `merge` for those tickets. */
export interface ZendeskVia {
  channel?: string | number | null
  source?: {
    rel?: string | null
    from?: {
      address?: string | null
      name?: string | null
      original_recipients?: unknown
      ticket_id?: number | string | null
      ticket_ids?: unknown
    } | null
    to?: { address?: string | null; name?: string | null; email_ccs?: unknown } | null
  } | null
}

/** A ticket as the incremental ticket export returns it. */
export interface ZendeskTicketRecord {
  id: number | string
  subject?: string | null
  status?: string | null
  brand_id?: number | string | null
  requester_id?: number | string | null
  collaborator_ids?: unknown
  email_cc_ids?: unknown
  follower_ids?: unknown
  tags?: unknown
  custom_fields?: unknown
  created_at?: string | null
  updated_at: string
  recipient?: string | null
  via?: ZendeskVia | null
  followup_ids?: unknown
}

/** A ticket comment (Zendesk's Ticket Comments reference). */
export interface ZendeskFullComment {
  id: number | string
  type?: string | null
  author_id?: number | string | null
  body?: string | null
  html_body?: string | null
  plain_body?: string | null
  public?: boolean
  created_at?: string | null
  audit_id?: number | string | null
  attachments?: ZendeskAttachment[]
  via?: ZendeskVia | null
  metadata?: { system?: Record<string, unknown> | null } | null
}

export interface ZendeskAudit {
  id?: number | string
  created_at?: string | null
  via?: ZendeskVia | null
  events?: unknown
}

export interface ZendeskSideEvent {
  id: number | string
  type?: string | null
  created_at?: string | null
  actor?: { name?: string | null; email?: string | null } | null
  message?: {
    subject?: string | null
    body?: string | null
    html_body?: string | null
    from?: { name?: string | null; email?: string | null } | null
    attachments?: ZendeskAttachment[]
  } | null
}

export interface ZendeskSideConversation {
  id: string
  subject: string | null
  events: ZendeskSideEvent[]
}

export interface ZendeskUser {
  id: number | string
  name?: string | null
  email?: string | null
  /** `end-user`, `agent`, or `admin`. */
  role?: string | null
}

/** A saved ticket version: what the backup saved for the ticket's newest `updated_at`. */
export interface TicketVersion {
  comments: ZendeskFullComment[]
  audits: ZendeskAudit[]
  sideConversations: ZendeskSideConversation[]
}

/** The archive's state as a run compares it: the backup's run count, its coverage, and whether a backup holds it. */
export interface ArchiveMark {
  runs: number
  coveredUntil: string | null
  locked: boolean
}

export const sameMark = (a: ArchiveMark, b: ArchiveMark) =>
  a.runs === b.runs && a.coveredUntil === b.coveredUntil && a.locked === b.locked

/** The files in a folder by name; none when it does not exist. */
async function files(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function folders(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

export class ArchiveReader {
  readonly archive: Archive

  constructor(root: string) {
    this.archive = new Archive(root)
  }

  async #json(relativePath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(this.archive.path(relativePath), "utf8")) as Record<string, unknown>
  }

  /** The pages of a list, in order: `<prefix>-000001.json`, ... in a folder (or `000001.json` with no prefix). */
  async #pages(folder: string, prefix: string): Promise<Record<string, unknown>[]> {
    const pattern = prefix ? new RegExp(`^${prefix}-\\d+\\.json$`) : /^\d+\.json$/
    const names = (await files(this.archive.path(folder))).filter((name) => pattern.test(name))
    const pages: Record<string, unknown>[] = []
    for (const name of names) pages.push(await this.#json(`${folder}/${name}`))
    return pages
  }

  /** archive.json, or undefined when the folder holds no Maane archive. */
  async info(): Promise<ArchiveInfo | undefined> {
    const info = await this.archive.info().catch(() => undefined)
    return info && info.format === ARCHIVE_FORMAT && info.version === ARCHIVE_VERSION ? info : undefined
  }

  async state(): Promise<ArchiveState> {
    return this.archive.state()
  }

  /** The mark a run compares before its first write and after each ticket. */
  async mark(): Promise<ArchiveMark> {
    const state = await this.archive.state()
    const locked = await stat(this.archive.path(".lock")).then(
      () => true,
      () => false,
    )
    return { runs: state.runs, coveredUntil: state.coveredUntil, locked }
  }

  /** The newest version of every ticket the export returned, by ID: a later page wins a tie. */
  async tickets(): Promise<Map<string, ZendeskTicketRecord>> {
    const newest = new Map<string, ZendeskTicketRecord>()
    for (const page of await this.#pages("raw/incremental/tickets", "")) {
      for (const record of list<ZendeskTicketRecord>(page.tickets)) {
        if (record?.id === undefined || typeof record.updated_at !== "string") continue
        const id = String(record.id)
        if (!/^\d{1,15}$/.test(id)) continue
        const known = newest.get(id)
        if (!known || known.updated_at <= record.updated_at) newest.set(id, record)
      }
    }
    return newest
  }

  /** Every user the users export returned, the newest record of each. */
  async users(): Promise<Map<string, ZendeskUser>> {
    const users = new Map<string, ZendeskUser>()
    for (const page of await this.#pages("raw/incremental/users", "")) {
      for (const user of list<ZendeskUser>(page.users)) if (user?.id !== undefined) users.set(String(user.id), user)
    }
    return users
  }

  /** The records of a collection's newest run, or none when it was not available. */
  async collection(name: string): Promise<Record<string, unknown>[]> {
    const runs = await folders(this.archive.path("raw", "collections", name))
    const newest = runs.at(-1)
    if (!newest) return []
    const records: Record<string, unknown>[] = []
    for (const page of await this.#pages(`raw/collections/${name}/${newest}`, ""))
      records.push(...list<Record<string, unknown>>(page[name]))
    return records
  }

  /** The saved lists of a ticket's version: its comments, audits, and side conversations with their events. */
  async version(id: string, updatedAt: string): Promise<TicketVersion> {
    if (!/^\d{1,15}$/.test(id)) throw new Error("not a ticket ID")
    const folder = `raw/tickets/${id}/${stamp(updatedAt)}`
    const comments = (await this.#pages(folder, "comments")).flatMap((page) => list<ZendeskFullComment>(page.comments))
    const audits = (await this.#pages(folder, "audits")).flatMap((page) => list<ZendeskAudit>(page.audits))
    const listed = (await this.#pages(folder, "side_conversations")).flatMap((page) =>
      list<{ id?: unknown; subject?: unknown }>(page.side_conversations),
    )
    const sideConversations: ZendeskSideConversation[] = []
    for (const side of listed) {
      const sideId = String(side.id ?? "")
      if (!/^[A-Za-z0-9-]{1,100}$/.test(sideId)) continue
      const events = (await this.#pages(`${folder}/side_conversations/${sideId}`, "events")).flatMap((page) =>
        list<ZendeskSideEvent>(page.events),
      )
      sideConversations.push({ id: sideId, subject: typeof side.subject === "string" ? side.subject : null, events })
    }
    return { comments, audits, sideConversations }
  }
}
