// The client address of a public request (plan 3.4, foundation "Client address"): the TCP peer, or, only when that peer
// is one of the configured trusted proxies (MAANE_TRUSTED_PROXIES, Traefik), the nearest address in X-Forwarded-For
// that is not a trusted proxy. proxy-addr (Express's own) walks the header that way. A forwarding header from any other
// peer is ignored, so a client cannot choose its own address for the rate limits or the click records.

import type { IncomingMessage } from "node:http"
import { CLICK_BOUNDS } from "@maane/shared"
import proxyAddr from "proxy-addr"

export type Trust = (address: string, hop: number) => boolean

/** The trust function of the configured proxies (addresses or CIDR ranges). An empty list trusts no peer. */
export function trustOf(proxies: readonly string[]): Trust {
  return proxyAddr.compile([...proxies])
}

/** The client address, an IPv4 address mapped into IPv6 written as IPv4; null without a socket (no Node server). */
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
