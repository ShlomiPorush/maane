// The one HTTP client for Maane's own API (/api/v1 and /api/setup). Every state-changing request carries the
// x-maane-request header (the server refuses it otherwise; the browser adds Origin itself), the session cookie goes
// along (same origin), and the server's {error: "code"} becomes an ApiError. A 401 and totp_required are reported to
// the app, which then goes to sign-in or to the two-factor setup. Better Auth's own routes go through its client
// (api/auth.ts), never through here.

export const API_BASE = "/api/v1"
/** The header the server requires on every state-changing request to /api/v1. */
export const REQUEST_HEADER = "x-maane-request"
/** A request without an answer fails after this long, so a hung request never holds a refresh. */
export const REQUEST_TIMEOUT_MS = 20_000

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type TransportRequest = { method: HttpMethod; url: string; headers: Record<string, string>; body?: string }
export type TransportResponse = { status: number; body: unknown }
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export class ApiError extends Error {
  /** 0 when no answer came. */
  readonly status: number
  /** The server's code ("setting_locked"), "network" when no answer came, "unknown" for an answer without one. */
  readonly code: string
  /** The error's other fields, such as the setting `key`. */
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(code)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

/** The browser transport: same-origin fetch with the session cookie. */
export const fetchTransport: Transport = async ({ method, url, headers, body }) => {
  const response = await fetch(url, {
    method,
    headers,
    credentials: "same-origin",
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  return { status: response.status, body: parsed }
}

let transport: Transport = fetchTransport
let unauthorizedHandler: ((error: ApiError) => void) | null = null

/** Replaces the transport (tests). */
export function setTransport(next: Transport): void {
  transport = next
}

/** Called on each 401 and on totp_required: the app goes to sign-in or to the two-factor setup. */
export function onUnauthorized(handler: ((error: ApiError) => void) | null): void {
  unauthorizedHandler = handler
}

/** The ApiError of a failed answer: the server's code, else one that follows from the status. */
export function errorFrom(status: number, body: unknown): ApiError {
  const answer = (body ?? {}) as { error?: unknown }
  if (typeof answer.error === "string" && answer.error) {
    const { error: code, ...details } = answer as Record<string, unknown>
    return new ApiError(status, String(code), details)
  }
  if (status === 401) return new ApiError(status, "unauthorized")
  if (status === 403) return new ApiError(status, "forbidden")
  if (status === 404) return new ApiError(status, "not_found")
  return new ApiError(status, "unknown")
}

/** A request to Maane's API. A path under /api/ is used as it is; any other path is under /api/v1. */
export async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (method !== "GET") headers[REQUEST_HEADER] = "1"
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const url = path.startsWith("/api/") ? path : `${API_BASE}${path}`
  let response: TransportResponse
  try {
    response = await transport({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, "network")
  }
  if (response.status >= 200 && response.status < 300) return response.body as T
  const error = errorFrom(response.status, response.body)
  if (error.status === 401 || error.code === "totp_required") unauthorizedHandler?.(error)
  throw error
}

/**
 * A file of Maane's API as bytes (a preview the UI draws itself: a PDF for pdf.js, a text). Same origin, with the
 * session cookie; a refusal becomes an ApiError like any other answer, and a 401 is reported the same way.
 */
export async function requestFile(url: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { credentials: "same-origin", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 3) })
  } catch {
    throw new ApiError(0, "network")
  }
  if (response.ok) return response
  const body = await response.json().catch(() => null)
  const error = errorFrom(response.status, body)
  if (error.status === 401 || error.code === "totp_required") unauthorizedHandler?.(error)
  throw error
}

/** A query string from the defined values only. */
export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}
