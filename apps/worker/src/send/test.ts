// The SMTP connection test of one provider (plan 3.1), the `smtp-test` job the Settings page queues: nodemailer's
// documented transporter.verify() connects with the saved settings (TLS required), logs in, and quits. It sends
// nothing.

import type { Settings } from "@maane/server/settings/service"
import type { Provider, SmtpProblem, SmtpTestResult } from "@maane/shared"
import { createTransport } from "nodemailer"
import { SMTP_TIMEOUTS, type SmtpTimeouts, smtpConfig } from "./smtp.ts"

const RESPONSE_MAX = 500

/** What an error of verify() means for the person reading the Settings page. */
function problemOf(code: string | undefined): SmtpProblem {
  if (code === "EAUTH" || code === "ENOAUTH") return "auth"
  if (code === "ETLS") return "tls"
  if (code === "ECONNECTION" || code === "ETIMEDOUT" || code === "ESOCKET" || code === "EDNS") return "connection"
  return "error"
}

export async function smtpTest(
  settings: Settings,
  provider: Provider,
  timeouts: SmtpTimeouts = SMTP_TIMEOUTS,
): Promise<SmtpTestResult> {
  const checkedAt = () => new Date().toISOString()
  const config = await smtpConfig(settings, provider)
  if (!config)
    return { provider, ok: false, problem: "not_configured", code: null, response: null, checkedAt: checkedAt() }
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: timeouts.connection,
    greetingTimeout: timeouts.greeting,
    socketTimeout: timeouts.socket,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
  })
  try {
    await transporter.verify()
    return { provider, ok: true, problem: null, code: null, response: null, checkedAt: checkedAt() }
  } catch (error) {
    const failure = error as { code?: string; response?: string }
    return {
      provider,
      ok: false,
      problem: problemOf(failure.code),
      code: failure.code ?? null,
      response: typeof failure.response === "string" ? failure.response.slice(0, RESPONSE_MAX) : null,
      checkedAt: checkedAt(),
    }
  } finally {
    transporter.close()
  }
}
