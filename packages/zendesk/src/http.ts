import { createHash, randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

/** How the client reaches Zendesk. Only `apiOrigin` ever receives the token. */
export interface ClientOptions {
  /** The account's API origin, `https://<subdomain>.zendesk.com`. */
  apiOrigin: string
  /** The value of the Authorization header for the API origin. Never logged. */
  authorization: string
  /** Tests run the stand-in API over plain HTTP. The command-line tool never sets this. */
  allowHttp?: boolean
  /**
   * The hosts a file download may reach, the API origin's host aside. By default Zendesk's own hosts:
   * `*.zendesk.com` and its content host `*.zdusercontent.com`. Anything else is refused, so a hostile link cannot
   * reach a host inside the operator's network.
   */
  fileHostAllowed?: (host: string) => boolean
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
  /** The time on Zendesk's clock when it answered (its Date header), if it sent one. */
  serverDate: Date | null
}

export interface Download {
  sha256: string
  bytes: number
}

const MAX_REDIRECTS = 5
const DOWNLOAD_ATTEMPTS = 3

/** Basic authentication with an API token, as Zendesk documents it: `{email}/token:{token}`. */
export function tokenAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}/token:${token}`).toString("base64")}`
}

/** Zendesk's own hosts. */
export function isZendeskFileHost(host: string): boolean {
  const name = host.toLowerCase()
  return name.endsWith(".zendesk.com") || name.endsWith(".zdusercontent.com")
}

/** A path and query only, for messages: no host, so nothing in a log points at the account. */
function describe(url: URL): string {
  return `${url.pathname}${url.search}`
}

export class ZendeskClient {
  readonly apiOrigin: string
  readonly #authorization: string
  readonly #allowHttp: boolean
  readonly #fileHostAllowed: (host: string) => boolean
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #maxAttempts: number

  constructor(options: ClientOptions) {
    const origin = new URL(options.apiOrigin)
    if (origin.protocol !== "https:" && !options.allowHttp) throw new Error("the Zendesk API origin must use HTTPS")
    this.apiOrigin = origin.origin
    this.#authorization = options.authorization
    this.#allowHttp = options.allowHttp ?? false
    this.#fileHostAllowed = options.fileHostAllowed ?? isZendeskFileHost
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

  /** GET on the API, with retries on rate limits, server errors, and dropped connections. */
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
      const date = response.headers.get("date")
      const serverDate = date && !Number.isNaN(Date.parse(date)) ? new Date(date) : null
      try {
        return { text, json: JSON.parse(text), serverDate }
      } catch {
        throw new ZendeskError(`an answer that is not JSON for ${describe(url)}`, response.status)
      }
    }
  }

  /**
   * Downloads a file into `target`, hashing it on the way. The token goes only to the API origin; a redirect to
   * another allowed host is followed without it. Every hop must use HTTPS and reach the API origin or an allowed
   * file host. The answer must be a complete 200, at most `maxBytes`, and of `expectedBytes` when Zendesk gave a
   * size. Rate limits, server errors, and dropped connections are retried. On failure nothing is left at `target`.
   */
  async download(source: string, target: string, maxBytes: number, expectedBytes: number | null): Promise<Download> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#downloadOnce(source, target, maxBytes, expectedBytes)
      } catch (error) {
        await rm(target, { force: true })
        const retry = error instanceof RetryableError
        if (!retry || attempt >= DOWNLOAD_ATTEMPTS) {
          throw error instanceof RetryableError ? new ZendeskError(error.message, error.status) : error
        }
        await this.#sleep(error.waitMs ?? backoff(attempt))
      }
    }
  }

  async #downloadOnce(source: string, target: string, maxBytes: number, expectedBytes: number | null) {
    let url = new URL(source)
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && !(this.#allowHttp && url.protocol === "http:")) {
        throw new ZendeskError(`refused a download that does not use HTTPS: ${describe(url)}`)
      }
      if (url.origin !== this.apiOrigin && !this.#fileHostAllowed(url.hostname)) {
        throw new ZendeskError(`refused a download from a host that is not Zendesk's: ${url.hostname}`)
      }
      const headers: Record<string, string> = {}
      if (url.origin === this.apiOrigin) headers.Authorization = this.#authorization
      let response: Response
      try {
        response = await this.#fetch(url, { headers, redirect: "manual" })
      } catch (error) {
        throw new RetryableError(`no answer for ${describe(url)}: ${errorText(error)}`)
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location) throw new ZendeskError(`a redirect without a location for ${describe(url)}`, response.status)
        if (hop >= MAX_REDIRECTS) throw new ZendeskError(`more than ${MAX_REDIRECTS} redirects for ${describe(url)}`)
        url = new URL(location, url)
        continue
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel()
        throw new RetryableError(`${response.status} for ${describe(url)}`, response.status, retryAfter(response))
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw new ZendeskError(`${response.status} for ${describe(url)}`, response.status)
      }
      const declared = Number(response.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel()
        throw new ZendeskError(`larger than the limit of ${maxBytes} bytes (${declared} bytes)`)
      }
      let result: Download
      try {
        result = await save(response.body, target, maxBytes)
      } catch (error) {
        // The connection dropped while the body arrived (fetch reports a TypeError): worth another attempt. A
        // file system error (a full disk, no permission) is not, and stops the run.
        if (error instanceof TypeError) throw new RetryableError(`the download of ${describe(url)} was cut off`)
        throw error
      }
      if (expectedBytes !== null && result.bytes !== expectedBytes) {
        throw new ZendeskError(`the download has ${result.bytes} bytes, Zendesk reported ${expectedBytes}`)
      }
      return result
    }
  }
}

/** A download failure that may pass on a later attempt. */
class RetryableError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly waitMs?: number,
  ) {
    super(message)
  }
}

/** Streams the body into a new file, hashing and counting it, and stops at the size limit. */
async function save(body: ReadableStream<Uint8Array>, target: string, maxBytes: number): Promise<Download> {
  const hash = createHash("sha256")
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > maxBytes) {
        callback(new ZendeskError(`larger than the limit of ${maxBytes} bytes`))
        return
      }
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(body as import("node:stream/web").ReadableStream),
    meter,
    // flush: the content is on the disk before the file is renamed and recorded as ok.
    createWriteStream(target, { flags: "wx", flush: true }),
  )
  return { sha256: hash.digest("hex"), bytes }
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
