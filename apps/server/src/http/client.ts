import type { IncomingMessage } from "node:http"
import { CLICK_BOUNDS } from "@maane/shared"
import proxyAddr from "proxy-addr"

export const CLIENT_ADDRESS_HEADER = "x-maane-client-address"

export type Trust = (address: string, hop: number) => boolean

export function trustOf(proxies: readonly string[]): Trust {
  return proxyAddr.compile([...proxies])
}

export function clientAddress(incoming: IncomingMessage | undefined, trust: Trust): string | null {
  if (!incoming?.socket) return null
  let address: string
  try {
    address = proxyAddr(incoming, trust)
  } catch {
    return null
  }
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  const ip = mapped?.[1] ?? address
  return ip && ip.length <= CLICK_BOUNDS.ip ? ip : null
}

const clients = new WeakMap<Request, string | null>()

export function rememberClient(request: Request, incoming: IncomingMessage | undefined, trust: Trust): void {
  clients.set(request, clientAddress(incoming, trust))
}

export function clientIp(request: Request | null | undefined): string | null {
  return request ? (clients.get(request) ?? null) : null
}

export function withClientAddress(request: Request): Request {
  const address = clientIp(request)
  if (address) request.headers.set(CLIENT_ADDRESS_HEADER, address)
  else request.headers.delete(CLIENT_ADDRESS_HEADER)
  return request
}
