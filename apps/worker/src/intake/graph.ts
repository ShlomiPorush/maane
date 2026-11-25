import { createHash } from "node:crypto"
import { ClientSecretCredential } from "@azure/identity"
import type { Settings } from "@maane/server/settings/service"
import { GRAPH_FOLDERS, type GraphFolder, type GraphProblem, type GraphTestResult } from "@maane/shared"
import { Client, GraphError } from "@microsoft/microsoft-graph-client"
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials"

export interface GraphConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  mailbox: string
}

export interface GraphEndpoints {
  authorityHost: string
  baseUrl: string
}

export async function graphConfig(settings: Settings): Promise<GraphConfig | null> {
  const config = {
    tenantId: (await settings.get("graph.tenantId")).trim(),
    clientId: (await settings.get("graph.clientId")).trim(),
    clientSecret: await settings.get("graph.clientSecret"),
    mailbox: (await settings.get("graph.mailbox")).trim().toLowerCase(),
  }
  return config.tenantId && config.clientId && config.clientSecret && config.mailbox ? config : null
}

const DELTA_SELECT = "id,receivedDateTime,internetMessageId,subject,from,parentFolderId"
const PREFER_IDS = 'IdType="ImmutableId"'
const PAGE_SIZE = 50
export const REQUEST_TIMEOUT_MS = 60_000
export const MIME_TIMEOUT_MS = 180_000

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
  nextLink: string | null
  deltaLink: string | null
}

export type MimeResult = { kind: "ok"; bytes: Buffer } | { kind: "too_large"; read: number }

export function graphStatus(error: unknown): number | null {
  return error instanceof GraphError && error.statusCode >= 100 ? error.statusCode : null
}

const CONCERNS_EVERY_CALL: ReadonlySet<number> = new Set([401, 429, 503, 509])

export function mayConcernOneMessage(error: unknown): boolean {
  const status = graphStatus(error)
  return status !== null && !CONCERNS_EVERY_CALL.has(status)
}

export function isExpiredDelta(error: unknown): boolean {
  if (!(error instanceof GraphError)) return false
  return error.statusCode === 410 || /^syncState(NotFound|Invalid)$/i.test(error.code ?? "")
}

export const isGone = (status: number | null) => status === 401 || status === 403 || status === 404

const safeCode = (code: unknown) => (typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null)

export function describeGraphError(error: unknown): {
  problem: GraphProblem
  code: string | null
  status: number | null
} {
  const status = graphStatus(error)
  if (error instanceof GraphError) {
    if (status === null) {
      const text = String(error.message ?? "")
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

  async folders(config: GraphConfig): Promise<Map<string, GraphFolder>> {
    const ids = new Map<string, GraphFolder>()
    for (const folder of GRAPH_FOLDERS) {
      const { id } = (await this.#clientFor(config)
        .api(`${this.#mailboxPath(config.mailbox)}/mailFolders/${folder}`)
        .header("Prefer", PREFER_IDS)
        .select("id")
        .option("signal", AbortSignal.timeout(REQUEST_TIMEOUT_MS))
        .get()) as { id: string }
      ids.set(id, folder)
    }
    return ids
  }

  firstDeltaLink(config: GraphConfig, folder: GraphFolder): string {
    return `${this.#mailboxPath(config.mailbox)}/mailFolders/${folder}/messages/delta?$select=${DELTA_SELECT}`
  }

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

  async metadata(config: GraphConfig, mailbox: string, graphId: string): Promise<DeltaItem> {
    return (await this.#clientFor(config)
      .api(`${this.#mailboxPath(mailbox)}/messages/${encodeURIComponent(graphId)}`)
      .header("Prefer", PREFER_IDS)
      .select(DELTA_SELECT)
      .option("signal", AbortSignal.timeout(REQUEST_TIMEOUT_MS))
      .get()) as DeltaItem
  }

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
