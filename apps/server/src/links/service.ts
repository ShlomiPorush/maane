import { randomBytes } from "node:crypto"
import {
  CLICKS_SHOWN,
  DEVICE_TYPES,
  type DeviceType,
  STORED_STATUSES,
  TRACKED_URL_MAX,
  type TrackedLinkView,
} from "@maane/shared"
import { and, asc, count, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"
import { linkClick, message, messagePart, storedFile, ticket, trackedLink } from "../db/schema.ts"
import type { Settings } from "../settings/service.ts"
import { parseAgent } from "./agent.ts"
import type { Geo } from "./geo.ts"
import { scannerReasons } from "./scanner.ts"

export const CODE = /^[A-Za-z0-9_-]{22}$/

export const newCode = () => randomBytes(16).toString("base64url")

export function linkBase(domain: string, publicUrl: URL): string {
  return domain ? `https://${domain}` : publicUrl.origin
}

export type NewLink = { code: string; kind: "url"; url: string } | { code: string; kind: "file"; partId: string }

export class ReplyLinks {
  readonly rows: NewLink[] = []
  readonly #urls = new Map<string, string>()

  constructor(
    private readonly base: string,
    private readonly tracking: boolean,
  ) {}

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

  file(partId: string): string {
    const code = newCode()
    this.rows.push({ code, kind: "file", partId })
    return `${this.base}/f/${code}`
  }
}

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
          inArray(message.direction, ["in", "out"]),
          inArray(messagePart.status, [...STORED_STATUSES]),
          isNotNull(messagePart.storedSha256),
        ),
      )
    return row ? { id: row.id, kind: "file", fileName: row.fileName, sha256: row.sha256 } : null
  }

  async record(linkId: string, input: ClickInput): Promise<void> {
    if ((await this.settings.get("links.tracking")) === "off") return
    const [location, agent] = await Promise.all([this.geo.locate(input.ip), parseAgent(input.userAgent)])
    await this.db.insert(linkClick).values({ linkId, ip: input.ip, ...location, ...agent })
  }
}

const isDevice = (value: string | null): value is DeviceType =>
  value !== null && (DEVICE_TYPES as readonly string[]).includes(value)

export async function linkViews(
  db: Pick<Db, "select">,
  replies: readonly { id: string; since: Date | null }[],
): Promise<Map<string, TrackedLinkView[]>> {
  const result = new Map<string, TrackedLinkView[]>()
  if (replies.length === 0) return result
  const links = await db
    .select({ link: trackedLink, fileName: messagePart.fileName, total: count(linkClick.id) })
    .from(trackedLink)
    .innerJoin(linkClick, eq(linkClick.linkId, trackedLink.id))
    .leftJoin(messagePart, eq(messagePart.id, trackedLink.partId))
    .where(
      inArray(
        trackedLink.messageId,
        replies.map((reply) => reply.id),
      ),
    )
    .groupBy(trackedLink.id, messagePart.fileName)
    .orderBy(
      desc(trackedLink.kind),
      asc(trackedLink.createdAt),
      asc(trackedLink.url),
      asc(messagePart.fileName),
      asc(trackedLink.id),
    )
  if (links.length === 0) return result
  const ranked = db
    .select({
      id: linkClick.id,
      rank: sql<number>`row_number() over (partition by ${linkClick.linkId} order by ${linkClick.at} desc, ${linkClick.id} desc)`.as(
        "rank",
      ),
    })
    .from(linkClick)
    .where(
      inArray(
        linkClick.linkId,
        links.map(({ link }) => link.id),
      ),
    )
    .as("ranked")
  const clicks = await db
    .select({ click: linkClick })
    .from(linkClick)
    .innerJoin(ranked, eq(ranked.id, linkClick.id))
    .where(lte(ranked.rank, CLICKS_SHOWN))
    .orderBy(desc(linkClick.at), desc(linkClick.id))
  const since = new Map(replies.map((reply) => [reply.id, reply.since]))
  const byLink = new Map<string, TrackedLinkView>()
  for (const { link, fileName, total } of links) {
    const view: TrackedLinkView = {
      id: link.id,
      kind: link.kind === "file" ? "file" : "url",
      target: link.url ?? fileName ?? "file",
      total,
      clicks: [],
    }
    byLink.set(link.id, view)
    result.set(link.messageId, [...(result.get(link.messageId) ?? []), view])
  }
  const replyOf = new Map(links.map(({ link }) => [link.id, link.messageId]))
  for (const { click } of clicks) {
    const view = byLink.get(click.linkId)
    if (!view) continue
    const device = isDevice(click.device) ? click.device : null
    view.clicks.push({
      id: click.id,
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
      scanner: scannerReasons(
        { at: click.at, asn: click.asn, device },
        since.get(replyOf.get(click.linkId) ?? "") ?? null,
      ),
    })
  }
  return result
}
