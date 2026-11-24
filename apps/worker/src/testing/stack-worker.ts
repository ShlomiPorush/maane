import { MESSAGES } from "@maane/shared"
import { simpleParser } from "mailparser"
import { startWorker } from "../main.ts"
import { fromCodePoints } from "./mime.ts"
import { startStandInSmtp } from "./smtp.ts"

const smtp2go = await startStandInSmtp()
const failover = await startStandInSmtp({ secure: true, acceptAll: true })
const worker = await startWorker({
  overrides: {
    "smtp2go.host": smtp2go.host,
    "smtp2go.port": String(smtp2go.port),
    "smtp2go.user": smtp2go.user,
    "smtp2go.password": smtp2go.password,
    "failover.host": failover.host,
    "failover.port": String(failover.port),
    "failover.security": "tls",
    "failover.user": failover.user,
    "failover.password": failover.password,
    "mail.bounceAddress": "bounces@example.com",
  },
})
console.log("stack worker ready")

const HEBREW = new RegExp(`[${fromCodePoints(0x5d0)}-${fromCodePoints(0x5ea)}]`)
const REFERENCE = new RegExp(`^\\S+: ${fromCodePoints(0x2066)}[A-Z0-9]{4}-[A-Z0-9]{4}${fromCodePoints(0x2069)}$`, "m")

function layoutOf(html: string, text: string): "yes" | "no" {
  const line = text.split(/\r?\n/)[0]
  const header = line === MESSAGES.he.mail.header || line === MESSAGES.en.mail.header
  const code = /<span dir="ltr">[A-Z0-9]{4}-[A-Z0-9]{4}<\/span>/.exec(html)
  const first = html.indexOf('class="email-avatar"')
  const quote = html.indexOf('<blockquote type="cite"')
  const quoted = quote > -1 && html.indexOf('class="email-avatar"', quote) > quote
  return header && code !== null && code.index < first && quoted && !html.includes('dir="auto"') ? "yes" : "no"
}

async function report(): Promise<void> {
  for (const [name, server] of [
    ["smtp2go", smtp2go],
    ["failover", failover],
  ] as const)
    for (const received of server.received) {
      const parsed = await simpleParser(received.raw, { skipImageLinks: true })
      const text = parsed.text ?? ""
      console.log(
        [
          `received ${name}`,
          `to=${received.to.join(",")}`,
          `from=${received.from}`,
          `hebrew=${HEBREW.test(text) ? "yes" : "no"}`,
          `english=${/English paragraph/.test(text) ? "yes" : "no"}`,
          `attachments=${parsed.attachments.filter((file) => !file.related).length}`,
          `reference=${REFERENCE.test(text) ? "yes" : "no"}`,
          `layout=${layoutOf(parsed.html || "", text)}`,
          `subject-number=${/\[#\d+\]/.test(parsed.subject ?? "") ? "yes" : "no"}`,
          `dropped=${received.dropped ? "yes" : "no"}`,
        ].join(" "),
      )
    }
}

process.once("SIGTERM", () => {
  void (async () => {
    await report().catch((error) => console.log(`report failed: ${String(error)}`))
    await worker.stop().catch(() => undefined)
    await smtp2go.close()
    await failover.close()
    process.exit(0)
  })()
})
