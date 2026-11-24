import { stat } from "node:fs/promises"
import { join } from "node:path"
import { CLICK_BOUNDS } from "@maane/shared"
import { type AsnResponse, type CityResponse, open, type Reader, type Response, validate } from "maxmind"
import { errorFacts, log } from "../log.ts"
import { bounded } from "./bounds.ts"

export const CITY_FILE = "GeoLite2-City.mmdb"
export const ASN_FILE = "GeoLite2-ASN.mmdb"

const CHECK_MS = 60_000

export interface Location {
  country: string | null
  city: string | null
  region: string | null
  isp: string | null
  asn: number | null
}

export const NO_LOCATION: Location = { country: null, city: null, region: null, isp: null, asn: null }

type Database<T extends Response> = { reader: Reader<T> | null; mtimeMs: number | null; checkedAt: number }

class GeoFile<T extends Response> {
  #state: Database<T> = { reader: null, mtimeMs: null, checkedAt: Number.NEGATIVE_INFINITY }
  #pending: Promise<void> | null = null

  constructor(
    private readonly path: string,
    private readonly now: () => number,
  ) {}

  async reader(): Promise<Reader<T> | null> {
    if (this.now() - this.#state.checkedAt >= CHECK_MS) {
      this.#pending ??= this.#refresh().finally(() => {
        this.#pending = null
      })
      await this.#pending
    }
    return this.#state.reader
  }

  async #refresh(): Promise<void> {
    const checkedAt = this.now()
    const found = await stat(this.path).catch(() => null)
    if (!found) {
      this.#state = { reader: null, mtimeMs: null, checkedAt }
      return
    }
    if (this.#state.reader && found.mtimeMs === this.#state.mtimeMs) {
      this.#state = { ...this.#state, checkedAt }
      return
    }
    try {
      this.#state = { reader: await open<T>(this.path), mtimeMs: found.mtimeMs, checkedAt }
    } catch (error) {
      log.warn("a GeoLite2 file could not be read", { file: this.path, ...errorFacts(error) })
      this.#state = { ...this.#state, checkedAt }
    }
  }
}

export class Geo {
  readonly #city: GeoFile<CityResponse> | null
  readonly #asn: GeoFile<AsnResponse> | null

  constructor(dir: string | null, now: () => number = Date.now) {
    this.#city = dir ? new GeoFile(join(dir, CITY_FILE), now) : null
    this.#asn = dir ? new GeoFile(join(dir, ASN_FILE), now) : null
  }

  async locate(ip: string | null): Promise<Location> {
    if (!ip || !validate(ip)) return NO_LOCATION
    const [city, asn] = await Promise.all([lookup(this.#city, ip), lookup(this.#asn, ip)])
    const iso = city?.country?.iso_code?.toLowerCase() ?? null
    return {
      country: iso && /^[a-z]{2}$/.test(iso) ? iso.slice(0, CLICK_BOUNDS.country) : null,
      city: bounded(city?.city?.names?.en, CLICK_BOUNDS.city),
      region: bounded(city?.subdivisions?.[0]?.names?.en, CLICK_BOUNDS.region),
      isp: bounded(asn?.autonomous_system_organization, CLICK_BOUNDS.isp),
      asn:
        typeof asn?.autonomous_system_number === "number" && Number.isSafeInteger(asn.autonomous_system_number)
          ? asn.autonomous_system_number
          : null,
    }
  }
}

async function lookup<T extends Response>(file: GeoFile<T> | null, ip: string): Promise<T | null> {
  if (!file) return null
  try {
    return (await file.reader())?.get(ip) ?? null
  } catch (error) {
    log.warn("a GeoLite2 lookup failed", errorFacts(error))
    return null
  }
}
