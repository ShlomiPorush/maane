import { randomBytes } from "node:crypto"
import { userEmail } from "@maane/shared"
import { secretOf, totp } from "./totp.ts"

export const TEST_ORIGIN = "http://127.0.0.1:8090"

export const testPassword = () => randomBytes(18).toString("base64url")

type Fetch = (request: Request, peer: string) => Response | Promise<Response>
// biome-ignore lint/suspicious/noExplicitAny: tests read each answer as the shape they expect
export type Answer = { status: number; json: any }

export class TestBrowser {
  readonly cookies = new Map<string, string>()

  constructor(
    private readonly fetch: Fetch,
    readonly ip: string,
    readonly origin = TEST_ORIGIN,
  ) {}

  async call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Answer> {
    const headers: Record<string, string> = { ...extra }
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ")
    if (method !== "GET") {
      headers.origin ??= this.origin
      headers["x-maane-request"] ??= "1"
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    const response = await this.fetch(
      new Request(`${this.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      this.ip,
    )
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = cookie.split(";")
      const eq = pair.indexOf("=")
      const name = pair.slice(0, eq)
      const value = pair.slice(eq + 1)
      if (!value || attributes.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a))) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = text
    }
    return { status: response.status, json }
  }

  get(path: string): Promise<Response> {
    const headers: Record<string, string> = {}
    if (this.cookies.size > 0) headers.cookie = [...this.cookies].map(([n, v]) => `${n}=${v}`).join("; ")
    return Promise.resolve(this.fetch(new Request(`${this.origin}${path}`, { headers }), this.ip))
  }

  setup(username: string, password: string): Promise<Answer> {
    return this.call("POST", "/api/auth/sign-up/email", {
      name: username,
      email: userEmail(username),
      username,
      password,
    })
  }

  async enable(password: string): Promise<{ secret: string; backupCodes: string[] }> {
    const res = await this.call("POST", "/api/auth/two-factor/enable", { password })
    if (res.status !== 200) throw new Error(`enable answered ${res.status}: ${JSON.stringify(res.json)}`)
    return { secret: secretOf(res.json.totpURI), backupCodes: res.json.backupCodes }
  }

  verify(code: string): Promise<Answer> {
    return this.call("POST", "/api/auth/two-factor/verify-totp", { code })
  }

  async enroll(password: string): Promise<string> {
    const { secret } = await this.enable(password)
    const verified = await this.verify(totp(secret))
    if (verified.status !== 200) throw new Error(`verify answered ${verified.status}: ${JSON.stringify(verified.json)}`)
    return secret
  }

  passwordSignIn(username: string, password: string): Promise<Answer> {
    return this.call("POST", "/api/auth/sign-in/username", { username, password })
  }

  async signIn(username: string, password: string, secret: string): Promise<void> {
    const first = await this.passwordSignIn(username, password)
    if (first.status !== 200 || !first.json?.twoFactorRedirect) {
      throw new Error(`sign-in answered ${first.status}: ${JSON.stringify(first.json)}`)
    }
    const second = await this.verify(totp(secret))
    if (second.status !== 200) throw new Error(`verify answered ${second.status}: ${JSON.stringify(second.json)}`)
  }
}

let address = 0
export const nextIp = () => {
  address++
  return `198.51.100.${(address % 250) + 1}`
}
