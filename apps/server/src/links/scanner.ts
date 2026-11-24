import type { DeviceType, ScannerReason } from "@maane/shared"

export const EARLY_SECONDS = 60

export const SCANNER_NETWORKS: ReadonlyMap<number, string> = new Map([
  [8075, "MICROSOFT-CORP-MSN-AS-BLOCK - Microsoft Corporation"],
  [22843, "PROOFPOINT-ASN-US-EAST - Proofpoint, Inc."],
  [26211, "PROOFPOINT-ASN-US-WEST - Proofpoint, Inc."],
  [52129, "PROOFPOINT-ASN-EU Proofpoint, Inc."],
  [30031, "MIMECAST-US - Mimecast North America Inc"],
  [15324, "BARRACUDA-NETWORKS-INC - Barracuda Networks, Inc."],
  [16417, "IRONPORT-SYSTEMS-INC - Cisco Systems Ironport Division"],
  [30214, "AS-IRONP-CASP - Cisco Systems Ironport Division"],
])

export interface ClickFacts {
  at: Date
  asn: number | null
  device: DeviceType | null
}

export function scannerReasons(click: ClickFacts, since: Date | null): ScannerReason[] {
  const reasons: ScannerReason[] = []
  if (since && click.at.getTime() - since.getTime() < EARLY_SECONDS * 1000) reasons.push("early")
  if (click.device === "bot") reasons.push("agent")
  if (click.asn !== null && SCANNER_NETWORKS.has(click.asn)) reasons.push("network")
  return reasons
}
