// Microsoft Graph, read only (plan 2.3): @azure/identity's ClientSecretCredential and the Graph client's documented
// TokenCredentialAuthenticationProvider, with the client's default middleware (its RetryHandler retries 429, 503, and
// 504 and honors Retry-After). Every request asks for immutable IDs (`Prefer: IdType="ImmutableId"`). Maane only reads:
// delta queries of a folder's messages, a message's raw MIME (`$value`), and, for the connection test, the Inbox
// folder's metadata. It never moves, marks, or deletes mail.
//
// Tests point the credential and the client at a stand-in through their documented options (authorityHost and
// disableInstanceDiscovery; baseUrl and customHosts), given to the constructor by test code only: production code
// never reads an address for them from the environment.

import { createHash } from "node:crypto"
import { ClientSecretCredential } from "@azure/identity"
import type { Settings } from "@maane/server/settings/service"
import type { GraphFolder, GraphProblem, GraphTestResult } from "@maane/shared"
import { Client, GraphError } from "@microsoft/microsoft-graph-client"
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials"

export interface GraphConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  /** In lower case. */
  mailbox: string
}

/** Where a stand-in answers; never set in production. */
export interface GraphEndpoints {
  /** An https authority host for the credential. */
  authorityHost: string
  /** An https base URL for Graph (`https://host:port/`). */
  baseUrl: string
}

/** The Graph settings in effect, or null while one of them is not set. */
export async function graphConfig(settings: Settings): Promise<GraphConfig | null> {
  const config = {
    tenantId: (await settings.get("graph.tenantId")).trim(),
    clientId: (await settings.get("graph.clientId")).trim(),
    clientSecret: await settings.get("graph.clientSecret"),
    mailbox: (await settings.get("graph.mailbox")).trim().toLowerCase(),
  }
  return config.tenantId && config.clientId && config.clientSecret && config.mailbox ? config : null
}

/** The fields the delta query asks for; the rest comes from the raw MIME. */
const DELTA_SELECT = "id,receivedDateTime,internetMessageId,subject,from,parentFolderId"
const PREFER_IDS = 'IdType="ImmutableId"'
const PAGE_SIZE = 50
/** A metadata request, and the whole raw message of a large one. */
export const REQUEST_TIMEOUT_MS = 60_000
export const MIME_TIMEOUT_MS = 180_000

/** One item of a delta page: a message, or a removal (`@removed`). */
export interface DeltaItem {
  id: string
  "@removed"?: { reason?: string }
  receivedDateTime?: string
  internetMessageId?: string
  subject?: string
  from?: { emailAddress?: { address?: string; name?: string } }
  parentFolderId?: string
}

export interface DeltaPage {
  items: DeltaItem[]
  /** The next page of this round. */
  nextLink: string | null
  /** The next round, once this was the last page. */
  deltaLink: string | null
}

export type MimeResult = { kind: "ok"; bytes: Buffer } | { kind: "too_large"; read: number }

/** Graph's HTTP status in an error, or null when no answer came (a network failure, a timeout, Entra's refusal). */
export function graphStatus(error: unknown): number | null {
  return error instanceof GraphError && error.statusCode >= 100 ? error.statusCode : null
}

/** A delta token Graph no longer knows (410 Gone, or the syncStateNotFound code): the folder needs a full sync. */
export function isExpiredDelta(error: unknown): boolean {
  if (!(error instanceof GraphError)) return false
  return error.statusCode === 410 || /^syncState(NotFound|Invalid)$/i.test(error.code ?? "")
}

/** The status that makes a waiting file `unavailable`: the message, or access to its mailbox, is gone (P5). */
export const isGone = (status: number | null) => status === 401 || status === 403 || status === 404

/** A code fit to show and log: letters, digits, and a few marks, never a message text. */
const safeCode = (code: unknown) => (typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null)

/** What went wrong in words of the connection test, and the code Entra or Graph gave. */
export function describeGraphError(error: unknown): {
  problem: GraphProblem
  code: string | null
  status: number | null
} {
  const status = graphStatus(error)
  if (error instanceof GraphError) {
    if (status === null) {
      const text = String(error.message ?? "")
      // Entra's refusal reaches the Graph client as an AuthenticationRequiredError: keep its OAuth error and its
      // AADSTS number, never the rest of the text.
      const oauth = /\b(invalid_client|unauthorized_client|invalid_request|invalid_grant|invalid_scope)\b/.exec(text)
      const aadsts = /\b(AADSTS\d{4,8})\b/.exec(text)
      if (/AuthenticationRequired|CredentialUnavailable/.test(error.code ?? "") || oauth || aadsts)
        return { problem: "credential", code: aadsts?.[1] ?? oauth?.[1] ?? safeCode(error.code), status }
      return { problem: "network", code: safeCode(error.code), status }
    }
    const code = safeCode(error.code)
    if (status === 401 || status === 403) return { problem: "access_denied", code, status }
    if (status === 404) return { problem: "not_found", code, status }
    if (status === 429) return { problem: "throttled", code, status }
    return { problem: "error", code, status }
  }
  const name = error instanceof Error ? error.name : ""
  if (name === "TimeoutError" || name === "AbortError") return { problem: "network", code: name, status: null }
  return { problem: "error", code: null, status: null }
}

/**
 * The worker's handle on Graph. One client per credential (tenant, application, secret), kept while they stay the
 * same, so the credential's token cache is reused; a new secret gets a new client.
 */
export class GraphGateway {
  readonly #endpoints: GraphEndpoints | null
  #client: { key: string; client: Client } | null = null

  constructor(endpoints: GraphEndpoints | null = null) {
    this.#endpoints = endpoints
  }

  #clientFor(config: GraphConfig): Client {
    const key = createHash("sha256")
      .update(JSON.stringify([config.tenantId, config.clientId, config.clientSecret]))
      .digest("hex")
    if (this.#client?.key === key) return this.#client.client
    const endpoints = this.#endpoints
    const credential = new ClientSecretCredential(
      config.tenantId,
      config.clientId,
      config.clientSecret,
      endpoints ? { authorityHost: endpoints.authorityHost, disableInstanceDiscovery: true } : {},
    )
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ["https://graph.microsoft.com/.default"],
    })
    const client = Client.initWithMiddleware(
      endpoints
        ? { authProvider, baseUrl: endpoints.baseUrl, customHosts: new Set([new URL(endpoints.baseUrl).hostname]) }
        : { authProvider },
    )
    this.#client = { key, client }
    return client
  }

  #mailboxPath(mailbox: string) {
    return `/users/${encodeURIComponent(mailbox)}`
  }

  /** The connection test: the Inbox folder's metadata, and nothing else. */
  async test(config: GraphConfig, now: () => Date = () => new Date()): Promise<GraphTestResult> {
    try {
      await this.#clientFor(config)
        .api(`${this.#mailboxPath(config.mailbox)}/mailFolders/inbox`)
        .header("Prefer", PREFER_IDS)
        .select("id,displayName")
        .option("signal", AbortSignal.timeout(REQUEST_TIMEOUT_MS))
        .get()
      return {
        ok: true,
        problem: null,
        code: null,
        status: 200,
        mailbox: config.mailbox,
        checkedAt: now().toISOString(),
      }
    } catch (error) {
      return { ok: false, ...describeGraphError(error), mailbox: config.mailbox, checkedAt: now().toISOString() }
    }
  }

  /** The first page of a full delta round of a folder. */
  firstDeltaLink(config: GraphConfig, folder: GraphFolder): string {
    return `${this.#mailboxPath(config.mailbox)}/mailFolders/${folder}/messages/delta?$select=${DELTA_SELECT}`
  }

  /** One page of a delta query: the first page's path, or a nextLink or deltaLink exactly as Graph gave it. */
  async delta(config: GraphConfig, link: string): Promise<DeltaPage> {
    const page = (await this.#clientFor(config)
      .api(link)
      .header("Prefer", `${PREFER_IDS}, odata.maxpagesize=${PAGE_SIZE}`)
      .option("signal", AbortSignal.timeout(REQUEST_TIMEOUT_MS))
      .get()) as { value?: DeltaItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }
    return {
      items: Array.isArray(page.value) ? page.value.filter((item) => typeof item?.id === "string") : [],
      nextLink: page["@odata.nextLink"] ?? null,
      deltaLink: page["@odata.deltaLink"] ?? null,
    }
  }

  /** A message's metadata again (subject, sender), for a record whose header values wait for the scanner. */
  async metadata(config: GraphConfig, mailbox: string, graphId: string): Promise<DeltaItem> {
    return (await this.#clientFor(config)
      .api(`${this.#mailboxPath(mailbox)}/messages/${encodeURIComponent(graphId)}`)
      .header("Prefer", PREFER_IDS)
      .select(DELTA_SELECT)
      .option("signal", AbortSignal.timeout(REQUEST_TIMEOUT_MS))
      .get()) as DeltaItem
  }

  /**
   * A message's raw MIME, read up to `limit` bytes: past it the download is cancelled and only that is reported.
   * Throws Graph's error (graphStatus says 404 for a vanished message).
   */
  async mime(config: GraphConfig, mailbox: string, graphId: string, limit: number): Promise<MimeResult> {
    const stream = (await this.#clientFor(config)
      .api(`${this.#mailboxPath(mailbox)}/messages/${encodeURIComponent(graphId)}/$value`)
      .header("Prefer", PREFER_IDS)
      .option("signal", AbortSignal.timeout(MIME_TIMEOUT_MS))
      .getStream()) as ReadableStream<Uint8Array>
    const chunks: Uint8Array[] = []
    let read = 0
    for await (const chunk of stream) {
      read += chunk.byteLength
      if (read > limit) return { kind: "too_large", read }
      chunks.push(chunk)
    }
    return { kind: "ok", bytes: Buffer.concat(chunks) }
  }
}
