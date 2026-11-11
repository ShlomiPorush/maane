import { createHash, randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"

/** How the client reaches Zendesk. Only `apiOrigin` ever receives the token. */
export interface ClientOptions {
  /** The account's API origin, `https://<subdomain>.zendesk.com`. */
  apiOrigin: string
  /** The value of the Authorization header for the API origin. Never logged. */
  authorization: string
  /** Tests run the stand-in API over plain HTTP. The command-line tool never sets this. */
  allowHttp?: boolean
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Attempts per request, including the first. */
  maxAttempts?: number
}

export class ZendeskError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ZendeskError"
  }
}

export interface JsonResponse {
  /** The body exactly as Zendesk sent it. */
  text: string
  json: unknown
}

export interface Download {
  sha256: string
  bytes: number
}

const MAX_REDIRECTS = 5

/** Basic authentication with an API token, as Zendesk documents it: `{email}/token:{token}`. */
export function tokenAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`
}

/** A path and query only, for messages: no host, so nothing in a log points at the account. */
function describe(url: URL): string {
  return `${url.pathname}${url.search}`
}

export class ZendeskClient {
  readonly apiOrigin: string
  readonly #authorization: string
  readonly #allowHttp: boolean
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxAttempts: number

  constructor(options: ClientOptions) {
    const origin = new URL(options.apiOrigin)
    if (origin.protocol !== "https:" && !options.allowHttp) throw new Error("the Zendesk API origin must use HTTPS")
    this.apiOrigin = origin.origin
    this.#authorization = options.authorization
    this.#allowHttp = options.allowHttp ?? false
    this.#fetch = options.fetch ?? fetch
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#maxAttempts = options.maxAttempts ?? 6
  }

  /** Resolves a path or a URL the API returned. Refuses any other origin: the token goes nowhere else. */
  apiUrl(pathOrUrl: string): URL {
    const url = new URL(pathOrUrl, this.apiOrigin)
    if (url.origin !== this.apiOrigin) throw new ZendeskError(`refused a link to another host: ${describe(url)}`)
    return url
  }

  /** GET on the API, with retries on rate limits, server errors and dropped connections. */
  async getJson(pathOrUrl: string): Promise<JsonResponse> {
    const url = this.apiUrl(pathOrUrl)
    for (let attempt = 1; ; attempt++) {
      let response: Response
      try {
        response = await this.#fetch(url, {
          headers: { Authorization: this.#authorization, Accept: "application/json" },
          redirect: "manual",
        })
      } catch (error) {
        if (attempt >= this.#maxAttempts) throw new ZendeskError(`no answer for ${describe(url)}: ${errorText(error)}`)
        await this.#sleep(backoff(attempt))
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel()
        if (attempt >= this.#maxAttempts) {
          throw new ZendeskError(`${response.status} for ${describe(url)} after ${attempt} attempts`, response.status)
        }
        await this.#sleep(retryAfter(response) ?? backoff(attempt))
        continue
      }
      const text = await response.text()
      if (!response.ok) throw new ZendeskError(`${response.status} for ${describe(url)}`, response.status)
      try {
        return { text, json: JSON.parse(text) }
      } catch {
        throw new ZendeskError(`an answer that is not JSON for ${describe(url)}`, response.status)
      }
    }
  }

  /**
   * Downloads a file into `target`, hashing it on the way. The token goes only to the API origin; a redirect
   * to any other host is followed without it. Every hop must use HTTPS. The file must not exceed `maxBytes`.
   * On failure nothing is left at `target`.
   */
  async download(source: string, target: string, maxBytes: number): Promise<Download> {
    let url = new URL(source)
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && !(this.#allowHttp && url.protocol === "http:")) {
        throw new ZendeskError(`refused a download that does not use HTTPS: ${describe(url)}`)
      }
      const headers: Record<string, string> = {}
      if (url.origin === this.apiOrigin) headers.Authorization = this.#authorization
      let response: Response
      try {
        response = await this.#fetch(url, { headers, redirect: "manual" })
      } catch (error) {
        throw new ZendeskError(`no answer for ${describe(url)}: ${errorText(error)}`)
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location) throw new ZendeskError(`a redirect without a location for ${describe(url)}`, response.status)
        if (hop >= MAX_REDIRECTS) throw new ZendeskError(`more than ${MAX_REDIRECTS} redirects for ${describe(url)}`)
        url = new URL(location, url)
        continue
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new ZendeskError(`${response.status} for ${describe(url)}`, response.status)
      }
      const declared = Number(response.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel()
        throw new ZendeskError(`larger than the limit of ${maxBytes} bytes (${declared} bytes)`)
      }
      return await this.#save(response.body, target, maxBytes)
    }
  }

  async #save(body: ReadableStream<Uint8Array>, target: string, maxBytes: number): Promise<Download> {
    const hash = createHash("sha256")
    const out = createWriteStream(target, { flags: "wx" })
    let bytes = 0
    try {
      for await (const chunk of body) {
        bytes += chunk.byteLength
        if (bytes > maxBytes) throw new ZendeskError(`larger than the limit of ${maxBytes} bytes`)
        hash.update(chunk)
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve))
      }
      await new Promise<void>((resolve, reject) =>
        out.end((error?: Error | null) => (error ? reject(error) : resolve())),
      )
      return { sha256: hash.digest("hex"), bytes }
    } catch (error) {
      out.destroy()
      await body.cancel().catch(() => {})
      await rm(target, { force: true })
      throw error
    }
  }
}

function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after")
  if (!value) return undefined
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 600) * 1000 : undefined
}

function backoff(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** (attempt - 1))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A random name for a file that is still being written. */
export function temporaryName(): string {
  return `.partial-${randomBytes(8).toString("hex")}`
}
