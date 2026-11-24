export const API_BASE = "/api/v1"
export const REQUEST_HEADER = "x-maane-request"
export const REQUEST_TIMEOUT_MS = 20_000

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
export type TransportRequest = { method: HttpMethod; url: string; headers: Record<string, string>; body?: string }
export type TransportResponse = { status: number; body: unknown }
export type Transport = (request: TransportRequest) => Promise<TransportResponse>

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown>

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(code)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.details = details
  }
}

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

export function setTransport(next: Transport): void {
  transport = next
}

export function onUnauthorized(handler: ((error: ApiError) => void) | null): void {
  unauthorizedHandler = handler
}

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

export async function sendFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData()
  form.set("file", file)
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", [REQUEST_HEADER]: "1" },
      credentials: "same-origin",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 15),
    })
  } catch {
    throw new ApiError(0, "network")
  }
  const body = await response.json().catch(() => null)
  if (response.ok) return body as T
  const error = errorFrom(response.status, body)
  if (error.status === 401 || error.code === "totp_required") unauthorizedHandler?.(error)
  throw error
}

export function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}
