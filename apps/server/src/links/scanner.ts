// "Possibly a scanner" (plan 3.4, requirements 3.4): security scanners such as Microsoft Safe Links open a mail's links
// before the customer does. A click is marked when it came within the first seconds after the reply was delivered
// (or sent, when no delivery time is known), from the user agent of a known crawler or program, or from the network of
// a provider known to scan links in mail. The mark states uncertainty, not a verdict: a Microsoft network
// also serves ordinary people. It is worked out when the ticket view reads the clicks, so a delivery time learned later
// and a change of this list apply to clicks already recorded.

import type { DeviceType, ScannerReason } from "@maane/shared"

/** A click this soon after delivery (or sending) is early. */
export const EARLY_SECONDS = 60

/**
 * Networks (AS numbers) of providers whose mail security opens links in mail. The holder of each was read from the
 * registry on 2026-11-13 (RIPEstat, https://stat.ripe.net/data/as-overview/data.json?resource=AS<number>).
 */
export const SCANNER_NETWORKS: ReadonlyMap<number, string> = new Map([
  // Microsoft Defender for Office 365 Safe Links, named in requirements 3.4.
  [8075, "MICROSOFT-CORP-MSN-AS-BLOCK - Microsoft Corporation"],
  // Proofpoint URL Defense.
  [22843, "PROOFPOINT-ASN-US-EAST - Proofpoint, Inc."],
  [26211, "PROOFPOINT-ASN-US-WEST - Proofpoint, Inc."],
  [52129, "PROOFPOINT-ASN-EU Proofpoint, Inc."],
  // Mimecast URL Protect.
  [30031, "MIMECAST-US - Mimecast North America Inc"],
  // Barracuda Email Protection.
  [15324, "BARRACUDA-NETWORKS-INC - Barracuda Networks, Inc."],
  // Cisco Secure Email (IronPort).
  [16417, "IRONPORT-SYSTEMS-INC - Cisco Systems Ironport Division"],
  [30214, "AS-IRONP-CASP - Cisco Systems Ironport Division"],
])

export interface ClickFacts {
  at: Date
  asn: number | null
  /** `bot`: uap-core's Spider family or a program's user agent (agent.ts). */
  device: DeviceType | null
}

/** Why a click may come from a scanner; `since` is the delivery time, or the sending time, or null when not sent. */
export function scannerReasons(click: ClickFacts, since: Date | null): ScannerReason[] {
  const reasons: ScannerReason[] = []
  if (since && click.at.getTime() - since.getTime() < EARLY_SECONDS * 1000) reasons.push("early")
  if (click.device === "bot") reasons.push("agent")
  if (click.asn !== null && SCANNER_NETWORKS.has(click.asn)) reasons.push("network")
  return reasons
}
