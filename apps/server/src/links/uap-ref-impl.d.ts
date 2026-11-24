declare module "uap-ref-impl" {
  interface UaResult {
    family: string
    major: string | null
    minor: string | null
    patch: string | null
  }
  interface OsResult {
    family: string
    major: string | null
    minor: string | null
    patch: string | null
  }
  interface DeviceResult {
    family: string
    brand: string | null
    model: string | null
  }
  interface Results {
    ua: UaResult
    os: OsResult
    device: DeviceResult
  }
  export default function parser(regexes: unknown): { parse: (userAgent: string) => Results }
}
