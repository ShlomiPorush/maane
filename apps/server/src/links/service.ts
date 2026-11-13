// Tracked links and download links (plan 3.4, requirements 3.4 and 4.3). A reply's email carries only random codes:
// `https://<link domain>/l/<code>` for a link the agent wrote, `https://<link domain>/f/<code>` for a file of an earlier
// message in its history. The codes and their targets are written with the reply, in its transaction; a code resolves
// only to what was stored, so nobody can use Maane to redirect elsewhere. A download is served only while its part is
// still a stored file (clean, or let through by the owner's policy: the rule of the ticket view's download) of an
// incoming message or a reply, never of an internal note. Each click and download is recorded with its address, the
// address's location from the local GeoLite2 files, and its parsed user agent, every string bounded.

import { randomBytes } from "node:crypto"
import {
  type ClickView,
  DEVICE_TYPES,
  type DeviceType,
  STORED_STATUSES,
  TRACKED_URL_MAX,
  type TrackedLinkView,
} from "@maane/shared"
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { linkClick, message, messagePart, storedFile, ticket, trackedLink } from "../db/schema.ts"
import type { Settings } from "../settings/service.ts"
import { parseAgent } from "./agent.ts"
import type { Geo } from "./geo.ts"
import { scannerReasons } from "./scanner.ts"

/** A code: 16 random bytes as base64url, 22 characters. */
export const CODE = /^[A-Za-z0-9_-]{22}$/

export const newCode = () => randomBytes(16).toString("base64url")

/** Where tracked links and download links point: https://<link domain>, or the public URL's own origin. */
export function linkBase(domain: string, publicUrl: URL): string {
  return domain ? `https://${domain}` : publicUrl.origin
}

/** A link row a reply writes with itself. */
export type NewLink = { code: string; kind: "url"; url: string } | { code: string; kind: "file"; partId: string }

/**
 * The links of one reply while its email is built: each distinct link the agent wrote gets one code (only while
 * tracking is on, and only an http or https URL within TRACKED_URL_MAX), and each history file one code.
 */
export class ReplyLinks {
  readonly rows: NewLink[] = []
  readonly #urls = new Map<string, string>()

  constructor(
    private readonly base: string,
    private readonly tracking: boolean,
  ) {}

  /** The address the email gives a link the agent wrote: its tracked link, or the link unchanged. */
  readonly url = (href: string): string => {
    if (!this.tracking || href.length > TRACKED_URL_MAX || !URL.canParse(href)) return href
    const parsed = new URL(href)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return href
    const known = this.#urls.get(parsed.href)
    if (known) return known
    const code = newCode()
    this.rows.push({ code, kind: "url", url: parsed.href })
    const tracked = `${this.base}/l/${code}`
    this.#urls.set(parsed.href, tracked)
    return tracked
  }

  /** The download link of a history file's part. */
  file(partId: string): string {
    const code = newCode()
    this.rows.push({ code, kind: "file", partId })
    return `${this.base}/f/${code}`
  }
}

/** What a code resolves to. */
export type Resolved =
  | { id: string; kind: "url"; url: string }
  | { id: string; kind: "file"; fileName: string | null; sha256: string }

export interface ClickInput {
  ip: string | null
  userAgent: string | null | undefined
}

export class Links {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly geo: Geo,
  ) {}

  /** The target of a code, or null: an unknown code, or a file link whose file may no longer be served. */
  async resolve(kind: "url" | "file", code: string): Promise<Resolved | null> {
    if (!CODE.test(code)) return null
    if (kind === "url") {
      const [row] = await this.db
        .select({ id: trackedLink.id, url: trackedLink.url })
        .from(trackedLink)
        .where(and(eq(trackedLink.code, code), eq(trackedLink.kind, "url")))
      return row?.url ? { id: row.id, kind: "url", url: row.url } : null
    }
    const [row] = await this.db
      .select({ id: trackedLink.id, fileName: messagePart.fileName, sha256: storedFile.sha256 })
      .from(trackedLink)
      .innerJoin(messagePart, eq(messagePart.id, trackedLink.partId))
      .innerJoin(message, eq(message.id, messagePart.messageId))
      .innerJoin(ticket, eq(ticket.id, message.ticketId))
      .innerJoin(storedFile, eq(storedFile.sha256, messagePart.storedSha256))
      .where(
        and(
          eq(trackedLink.code, code),
          eq(trackedLink.kind, "file"),
          // Never a file of an internal note; only a stored file, as the ticket view's download.
          inArray(message.direction, ["in", "out"]),
          inArray(messagePart.status, [...STORED_STATUSES]),
          isNotNull(messagePart.storedSha256),
        ),
      )
    return row ? { id: row.id, kind: "file", fileName: row.fileName, sha256: row.sha256 } : null
  }

  /** Records one click or download, unless tracking is off. A failure never stops the redirect or the download. */
  async record(linkId: string, input: ClickInput): Promise<void> {
    if ((await this.settings.get("links.tracking")) === "off") return
    const [location, agent] = await Promise.all([this.geo.locate(input.ip), parseAgent(input.userAgent)])
    await this.db.insert(linkClick).values({ linkId, ip: input.ip, ...location, ...agent })
  }
}

const isDevice = (value: string | null): value is DeviceType =>
  value !== null && (DEVICE_TYPES as readonly string[]).includes(value)

/**
 * The clicked links and downloaded files of replies, for the ticket view: per reply, each link with at least one click,
 * its clicks newest first, each with its scanner reasons against `since` (the delivery or sending time of the reply).
 */
export async function linkViews(
  db: Pick<Db, "select">,
  replies: readonly { id: string; since: Date | null }[],
): Promise<Map<string, TrackedLinkView[]>> {
  const result = new Map<string, TrackedLinkView[]>()
  if (replies.length === 0) return result
  const rows = await db
    .select({ link: trackedLink, fileName: messagePart.fileName, click: linkClick })
    .from(trackedLink)
    .innerJoin(linkClick, eq(linkClick.linkId, trackedLink.id))
    .leftJoin(messagePart, eq(messagePart.id, trackedLink.partId))
    .where(
      inArray(
        trackedLink.messageId,
        replies.map((reply) => reply.id),
      ),
    )
    // Links first, then files; each in the order the reply wrote them, then by target (a reply writes all at once).
    .orderBy(
      desc(trackedLink.kind),
      asc(trackedLink.createdAt),
      asc(trackedLink.url),
      asc(messagePart.fileName),
      asc(trackedLink.id),
      desc(linkClick.at),
      desc(linkClick.id),
    )
  const since = new Map(replies.map((reply) => [reply.id, reply.since]))
  const byLink = new Map<string, TrackedLinkView>()
  for (const { link, fileName, click } of rows) {
    let view = byLink.get(link.id)
    if (!view) {
      view = { kind: link.kind === "file" ? "file" : "url", target: link.url ?? fileName ?? "file", clicks: [] }
      byLink.set(link.id, view)
      result.set(link.messageId, [...(result.get(link.messageId) ?? []), view])
    }
    const device = isDevice(click.device) ? click.device : null
    const entry: ClickView = {
      at: click.at.toISOString(),
      ip: click.ip,
      country: click.country,
      city: click.city,
      region: click.region,
      isp: click.isp,
      asn: click.asn,
      device,
      os: click.os,
      browser: click.browser,
      userAgent: click.userAgent,
      scanner: scannerReasons({ at: click.at, asn: click.asn, device }, since.get(link.messageId) ?? null),
    }
    view.clicks.push(entry)
  }
  return result
}
