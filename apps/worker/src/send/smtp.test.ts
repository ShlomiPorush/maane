import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type StandInSmtp, startSilentServer, startStandInSmtp } from "../testing/smtp.ts"
import { deliver, type SmtpConfig, type SmtpTimeouts, sendFailure } from "./smtp.ts"

// One attempt against stand-in SMTP servers (plan 3.1): what each outcome of nodemailer's SMTPConnection means for
// the recipients. The stand-ins use TLS with certificates made for this run, trusted in this process only, and accept
// only the user and password they generated.

const QUICK: SmtpTimeouts = { connection: 2000, greeting: 1500, socket: 3000, setup: 4000, send: 5000 }
const MIME = Buffer.from(
  "From: Agent <help@example.com>\r\nTo: dana@example.com\r\nSubject: Hello\r\nMessage-ID: <a@example.com>\r\n\r\nHello\r\n",
)

let starttls: StandInSmtp
let implicit: StandInSmtp

beforeAll(async () => {
  starttls = await startStandInSmtp()
  implicit = await startStandInSmtp({ secure: true })
})
afterAll(async () => {
  await starttls.close()
  await implicit.close()
})

const configOf = (server: StandInSmtp, values: Partial<SmtpConfig> = {}): SmtpConfig => ({
  provider: "smtp2go",
  host: server.host,
  port: server.port,
  secure: server.secure,
  user: server.user,
  password: server.password,
  ...values,
})
const send = (config: SmtpConfig, to: string[]) => deliver(config, { from: "help@example.com", to }, MIME, QUICK)

describe("one attempt", () => {
  it("accepts every recipient with the final 250 and keeps its queue ID, over STARTTLS and over TLS", async () => {
    for (const server of [starttls, implicit]) {
      const before = server.received.length
      const result = await send(configOf(server), ["dana@example.com", "ron@example.com"])
      expect(result).toMatchObject({ kind: "answered", accepted: ["dana@example.com", "ron@example.com"], refused: [] })
      const last = server.received.at(-1)
      expect(server.received.length).toBe(before + 1)
      expect(result.kind === "answered" && result.response).toContain(`OK id=${last?.queueId}`)
      expect(last?.to).toEqual(["dana@example.com", "ron@example.com"])
      expect(last?.from).toBe("help@example.com")
    }
  })

  it("refuses a recipient refused at RCPT TO and accepts the others", async () => {
    const result = await send(configOf(starttls), ["dana@example.com", "refuse.ron@example.com"])
    expect(result).toMatchObject({
      kind: "answered",
      accepted: ["dana@example.com"],
      refused: [{ address: "refuse.ron@example.com", response: expect.stringMatching(/^550 /) }],
    })
  })

  it("refuses every recipient when RCPT TO refused them all, before any data", async () => {
    const before = starttls.received.length
    const result = await send(configOf(starttls), ["refuse.a@example.com", "defer.b@example.com"])
    expect(result).toMatchObject({
      kind: "answered",
      accepted: [],
      refused: [
        { address: "refuse.a@example.com", response: expect.stringMatching(/^550 /) },
        { address: "defer.b@example.com", response: expect.stringMatching(/^451 /) },
      ],
    })
    expect(starttls.received.length).toBe(before)
  })

  it("refuses every recipient on a 4xx or 5xx final reply after the data", async () => {
    for (const [local, code] of [
      ["reject", "554"],
      ["tempfail", "451"],
    ]) {
      const result = await send(configOf(starttls), ["dana@example.com", `${local}@example.com`])
      expect(result).toMatchObject({ kind: "answered", accepted: [] })
      if (result.kind !== "answered") throw new Error("not answered")
      expect(result.refused.map((entry) => entry.address)).toEqual(["dana@example.com", `${local}@example.com`])
      expect(result.response).toMatch(new RegExp(`^${code} `))
    }
  })

  it("is unknown when the server stored the message and dropped the connection before its final reply", async () => {
    const before = starttls.received.length
    const result = await send(configOf(starttls), ["dana@example.com", "drop.ron@example.com"])
    expect(result).toMatchObject({ kind: "unknown" })
    expect(starttls.received.length).toBe(before + 1)
    expect(starttls.received.at(-1)?.dropped).toBe(true)
  })

  it("is unknown when the server took the data and never gave its final reply, by the socket's or the step's deadline", async () => {
    for (const timeouts of [QUICK, { ...QUICK, socket: 20_000, send: 1500 }]) {
      const before = starttls.received.length
      const started = Date.now()
      const result = await deliver(
        configOf(starttls),
        { from: "help@example.com", to: ["stall@example.com"] },
        MIME,
        timeouts,
      )
      expect(result).toMatchObject({ kind: "unknown", code: "ETIMEDOUT" })
      expect(Date.now() - started).toBeLessThan(Math.min(timeouts.socket, timeouts.send) + 2000)
      expect(starttls.received.length).toBe(before + 1)
    }
  })

  it("sends nothing when the login fails", async () => {
    const before = starttls.received.length
    const result = await send(configOf(starttls, { password: `${starttls.password}x` }), ["dana@example.com"])
    expect(result).toMatchObject({ kind: "not_sent", step: "login", code: "EAUTH" })
    expect(starttls.received.length).toBe(before)
  })

  it("sends nothing when the server speaks no TLS: TLS is required", async () => {
    const plain = await startStandInSmtp({ noTls: true })
    try {
      const result = await send(configOf(plain), ["dana@example.com"])
      expect(result).toMatchObject({ kind: "not_sent", step: "connect" })
      expect(plain.received).toEqual([])
    } finally {
      await plain.close()
    }
  })

  it("sends nothing to a server whose certificate is not trusted", async () => {
    const untrusted = await startStandInSmtp({ trust: false })
    try {
      const result = await send(configOf(untrusted), ["dana@example.com"])
      expect(result).toMatchObject({ kind: "not_sent", step: "connect" })
      expect(untrusted.received).toEqual([])
    } finally {
      await untrusted.close()
    }
  })

  it("sends nothing when the connection is refused, or the server never greets", async () => {
    const closed = await startSilentServer()
    const port = closed.port
    await closed.close()
    expect(await send(configOf(starttls, { port }), ["dana@example.com"])).toMatchObject({
      kind: "not_sent",
      step: "connect",
    })
    const silent = await startSilentServer()
    try {
      const started = Date.now()
      expect(await send(configOf(starttls, { port: silent.port }), ["dana@example.com"])).toMatchObject({
        kind: "not_sent",
        step: "connect",
      })
      expect(Date.now() - started).toBeLessThan(QUICK.setup + 1000)
    } finally {
      await silent.close()
    }
  })
})

describe("a failed send", () => {
  it("is a refusal only for an answer the server gave before or instead of taking the message", () => {
    const to = ["dana@example.com"]
    const error = (values: object) => Object.assign(new Error("failed"), values)
    expect(sendFailure(error({ code: "EENVELOPE", command: "MAIL FROM", responseCode: 550 }), to).kind).toBe("answered")
    expect(sendFailure(error({ code: "EENVELOPE", command: "DATA", responseCode: 554 }), to).kind).toBe("answered")
    expect(sendFailure(error({ code: "EMESSAGE", command: "DATA", responseCode: 552 }), to).kind).toBe("answered")
    expect(sendFailure(error({ code: "EMESSAGE", command: "MAIL FROM" }), to).kind).toBe("answered")
    for (const values of [
      { code: "ECONNECTION", command: "CONN" },
      { code: "ECONNECTION", command: "CONN", responseCode: 421 },
      { code: "ETIMEDOUT", command: "CONN" },
      { code: "ESOCKET" },
      { code: "EPROTOCOL", command: "CONN" },
      { code: "ESTREAM" },
      {},
    ])
      expect(sendFailure(error(values), to).kind).toBe("unknown")
  })
})
