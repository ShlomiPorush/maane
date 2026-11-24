import { readdir, readFile, stat } from "node:fs/promises"
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, Archive, type ArchiveInfo, type ArchiveState, stamp } from "./archive.ts"
import type { ZendeskAttachment } from "./sources.ts"

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
  metadata?: { system?: Record<string, unknown> | null; via?: ZendeskVia | null } | null
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
  role?: string | null
}

export interface TicketVersion {
  comments: ZendeskFullComment[]
  audits: ZendeskAudit[]
  sideConversations: ZendeskSideConversation[]
}

export interface ArchiveMark {
  runs: number
  coveredUntil: string | null
  locked: boolean
}

export const sameMark = (a: ArchiveMark, b: ArchiveMark) =>
  a.runs === b.runs && a.coveredUntil === b.coveredUntil && a.locked === b.locked

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
  #state: { id: string; state: ArchiveState } | null = null

  constructor(root: string) {
    this.archive = new Archive(root)
  }

  async #json(relativePath: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(this.archive.path(relativePath), "utf8")) as Record<string, unknown>
  }

  async *#pages(folder: string, prefix: string): AsyncGenerator<Record<string, unknown>> {
    const pattern = prefix ? new RegExp(`^${prefix}-\\d+\\.json$`) : /^\d+\.json$/
    const names = (await files(this.archive.path(folder))).filter((name) => pattern.test(name))
    for (const name of names) yield await this.#json(`${folder}/${name}`)
  }

  async #records<T>(folder: string, prefix: string, key: string): Promise<T[]> {
    const records: T[] = []
    for await (const page of this.#pages(folder, prefix)) records.push(...list<T>(page[key]))
    return records
  }

  async info(): Promise<ArchiveInfo | undefined> {
    const info = await this.archive.info().catch(() => undefined)
    return info && info.format === ARCHIVE_FORMAT && info.version === ARCHIVE_VERSION ? info : undefined
  }

  async state(): Promise<ArchiveState> {
    return this.archive.state()
  }

  async mark(): Promise<ArchiveMark> {
    const state = await this.#currentState()
    const locked = await stat(this.archive.path(".lock")).then(
      () => true,
      () => false,
    )
    return { runs: state.runs, coveredUntil: state.coveredUntil, locked }
  }

  async #currentState(): Promise<ArchiveState> {
    const facts = await stat(this.archive.path("state.json"), { bigint: true }).catch(() => null)
    const id = facts ? [facts.dev, facts.ino, facts.size, facts.mtimeNs, facts.ctimeNs].join(":") : "none"
    if (this.#state?.id === id) return this.#state.state
    const state = await this.archive.state()
    this.#state = { id, state }
    return state
  }

  async tickets(): Promise<Map<string, ZendeskTicketRecord>> {
    const newest = new Map<string, ZendeskTicketRecord>()
    for await (const page of this.#pages("raw/incremental/tickets", "")) {
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

  async users(): Promise<Map<string, ZendeskUser>> {
    const users = new Map<string, ZendeskUser>()
    for await (const page of this.#pages("raw/incremental/users", "")) {
      for (const user of list<ZendeskUser>(page.users)) if (user?.id !== undefined) users.set(String(user.id), user)
    }
    return users
  }

  async collection(name: string): Promise<Record<string, unknown>[]> {
    const runs = await folders(this.archive.path("raw", "collections", name))
    const newest = runs.at(-1)
    if (!newest) return []
    return this.#records<Record<string, unknown>>(`raw/collections/${name}/${newest}`, "", name)
  }

  async version(id: string, updatedAt: string): Promise<TicketVersion> {
    if (!/^\d{1,15}$/.test(id)) throw new Error("not a ticket ID")
    const folder = `raw/tickets/${id}/${stamp(updatedAt)}`
    const comments = await this.#records<ZendeskFullComment>(folder, "comments", "comments")
    const audits = await this.#records<ZendeskAudit>(folder, "audits", "audits")
    const listed = await this.#records<{ id?: unknown; subject?: unknown }>(
      folder,
      "side_conversations",
      "side_conversations",
    )
    const sideConversations: ZendeskSideConversation[] = []
    for (const side of listed) {
      const sideId = String(side.id ?? "")
      if (!/^[A-Za-z0-9-]{1,100}$/.test(sideId)) continue
      const events = await this.#records<ZendeskSideEvent>(`${folder}/side_conversations/${sideId}`, "events", "events")
      sideConversations.push({ id: sideId, subject: typeof side.subject === "string" ? side.subject : null, events })
    }
    return { comments, audits, sideConversations }
  }
}
