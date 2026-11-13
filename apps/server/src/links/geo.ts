// Where a click's address is (plan 3.4, requirements 3.4): read from the owner's local MaxMind GeoLite2 City and ASN
// files with the `maxmind` library, never from an outside service. The directory is mounted read-only
// (MAANE_GEOIP_DIR, deployment wiring) and the owner's own updater keeps the files current. Each file is optional and
// fails alone: without it, its part of the location stays empty and the click is still recorded. A file is opened on
// first use and opened again when its modification time changes (checked at most once a minute); a file that cannot be
// read keeps the last good copy, and a missing one is looked for again on the next check.

import { stat } from "node:fs/promises"
import { join } from "node:path"
import { CLICK_BOUNDS } from "@maane/shared"
import { type AsnResponse, type CityResponse, open, type Reader, type Response, validate } from "maxmind"
import { errorFacts, log } from "../log.ts"
import { bounded } from "./bounds.ts"

export const CITY_FILE = "GeoLite2-City.mmdb"
export const ASN_FILE = "GeoLite2-ASN.mmdb"

/** How often a file is looked at again for a change or for its first appearance. */
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
      // A file being replaced or damaged: the last good copy stays (or none), and the next check tries again.
      log.warn("a GeoLite2 file could not be read", { file: this.path, ...errorFacts(error) })
      this.#state = { ...this.#state, checkedAt }
    }
  }
}

export class Geo {
  readonly #city: GeoFile<CityResponse> | null
  readonly #asn: GeoFile<AsnResponse> | null

  /** `dir` null: no directory is configured, and every location stays empty. */
  constructor(dir: string | null, now: () => number = Date.now) {
    this.#city = dir ? new GeoFile(join(dir, CITY_FILE), now) : null
    this.#asn = dir ? new GeoFile(join(dir, ASN_FILE), now) : null
  }

  /** The location of an address, each part bounded; a part whose file is missing or that fails stays empty. */
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
