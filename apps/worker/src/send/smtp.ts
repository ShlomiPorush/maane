import type { Settings } from "@maane/server/settings/service"
import { type Provider, SMTP_TLS_PORTS, type SmtpSecurity } from "@maane/shared"
import SMTPConnection, { type SMTPConnectionSendInfo } from "nodemailer/lib/smtp-connection"

export interface SmtpConfig {
  provider: Provider
  host: string
  port: number
  secure: boolean
  user: string
  password: string
}

export async function smtpConfig(settings: Settings, provider: Provider): Promise<SmtpConfig | null> {
  if (provider === "smtp2go") {
    const host = await settings.get("smtp2go.host")
    const port = await settings.get("smtp2go.port")
    const user = await settings.get("smtp2go.user")
    const password = await settings.get("smtp2go.password")
    if (!host || !user || !password) return null
    return { provider, host, port, secure: SMTP_TLS_PORTS.includes(port), user, password }
  }
  const host = await settings.get("failover.host")
  const user = await settings.get("failover.user")
  const password = await settings.get("failover.password")
  if (!host || Boolean(user) !== Boolean(password)) return null
  const security: SmtpSecurity = await settings.get("failover.security")
  return { provider, host, port: await settings.get("failover.port"), secure: security === "tls", user, password }
}

export interface SmtpTimeouts {
  connection: number
  greeting: number
  socket: number
  setup: number
  send: number
}

export const SMTP_TIMEOUTS: SmtpTimeouts = {
  connection: 30_000,
  greeting: 30_000,
  socket: 120_000,
  setup: 90_000,
  send: 10 * 60_000,
}

const RESPONSE_MAX = 500
const bounded = (text: unknown) => (typeof text === "string" && text !== "" ? text.slice(0, RESPONSE_MAX) : null)

export type Delivery =
  | { kind: "not_sent"; step: "connect" | "login"; code: string | null; response: string | null }
  | {
      kind: "answered"
      accepted: string[]
      refused: { address: string; response: string | null }[]
      response: string | null
    }
  | { kind: "unknown"; code: string | null; response: string | null }

type SmtpError = Error & {
  code?: string
  command?: string
  response?: string
  responseCode?: number
  recipient?: string
  rejectedErrors?: SmtpError[]
}

export function sendFailure(error: SmtpError, to: string[]): Delivery {
  const replied = typeof error.responseCode === "number" && error.responseCode >= 400
  const refusedEnvelope = error.code === "EENVELOPE"
  const refusedAfterData = error.code === "EMESSAGE" && error.command === "DATA" && replied
  const neverStarted =
    error.code === "EMESSAGE" && (error.command === "MAIL FROM" || error.command === "API") && !replied
  if (!refusedEnvelope && !refusedAfterData && !neverStarted)
    return { kind: "unknown", code: error.code ?? null, response: bounded(error.response) }
  const perRecipient = new Map(
    (error.rejectedErrors ?? []).flatMap((entry) =>
      entry.recipient ? [[entry.recipient.toLowerCase(), bounded(entry.response)] as const] : [],
    ),
  )
  const response = bounded(error.response)
  return {
    kind: "answered",
    accepted: [],
    refused: to.map((address) => ({ address, response: perRecipient.get(address) ?? response })),
    response,
  }
}

export async function deliver(
  config: SmtpConfig,
  envelope: { from: string; to: string[] },
  mime: Buffer,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS,
): Promise<Delivery> {
  const connection = new SMTPConnection({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    name: envelope.from.slice(envelope.from.lastIndexOf("@") + 1) || undefined,
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    logger: false,
  })
  // Without this listener, a connection reset after a step settled would crash the whole worker process.
  connection.on("error", () => {})

  const step = <T>(deadline: number, run: (done: (error: SmtpError | null, value?: T) => void) => void) =>
    new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (error: SmtpError | null, value?: T) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        connection.off("error", onError)
        connection.off("end", onEnd)
        if (error) reject(error)
        else resolve(value as T)
      }
      const onError = (error: SmtpError) => finish(error)
      const onEnd = () => finish(Object.assign(new Error("the connection ended"), { code: "ECONNECTION" }))
      const timer = setTimeout(() => {
        finish(Object.assign(new Error("the step took too long"), { code: "ETIMEDOUT" }))
        connection.close()
      }, deadline)
      connection.on("error", onError)
      connection.once("end", onEnd)
      run(finish)
    })

  try {
    let stepName: "connect" | "login" = "connect"
    try {
      const started = Date.now()
      await step<void>(timeouts.setup, (done) => connection.connect((error) => done(error ?? null)))
      if (config.user) {
        stepName = "login"
        await step<boolean>(Math.max(1000, timeouts.setup - (Date.now() - started)), (done) =>
          connection.login({ user: config.user, pass: config.password }, (error, ok) => done(error, ok)),
        )
      }
    } catch (error) {
      const failure = error as SmtpError
      return { kind: "not_sent", step: stepName, code: failure.code ?? null, response: bounded(failure.response) }
    }
    try {
      const info = await step<SMTPConnectionSendInfo>(timeouts.send, (done) =>
        connection.send({ from: envelope.from, to: envelope.to }, mime, (error, result) =>
          done((error as SmtpError | null) ?? null, result),
        ),
      )
      const accepted = new Set(info.accepted.map((address) => address.toLowerCase()))
      const rejected = new Map(
        (info.rejectedErrors ?? []).flatMap((entry) => {
          const recipient = (entry as SmtpError).recipient
          return recipient ? [[recipient.toLowerCase(), bounded((entry as SmtpError).response)] as const] : []
        }),
      )
      return {
        kind: "answered",
        accepted: envelope.to.filter((address) => accepted.has(address)),
        refused: envelope.to
          .filter((address) => !accepted.has(address))
          .map((address) => ({ address, response: rejected.get(address) ?? null })),
        response: bounded(info.response),
      }
    } catch (error) {
      return sendFailure(error as SmtpError, envelope.to)
    }
  } finally {
    if (!connection.destroyed) connection.quit()
    setTimeout(() => connection.close(), 5_000).unref()
  }
}
