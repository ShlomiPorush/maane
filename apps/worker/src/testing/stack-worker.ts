import { simpleParser } from "mailparser"
import { startWorker } from "../main.ts"
import { fromCodePoints } from "./mime.ts"
import { startStandInSmtp } from "./smtp.ts"

// The worker of the container stack while the end-to-end tests send replies (scripts/verify.sh stops the stack's own
// worker for them): the same worker, started by startWorker as index.ts starts it, in a container of the worker
// service, with two stand-in SMTP servers inside this process. SMTP2GO's stand-in speaks STARTTLS and plays an outcome
// by the recipient's local part (testing/smtp.ts); the failover's speaks TLS from the first byte and accepts
// everything. Their certificates are trusted in this process only, and their addresses and credentials, generated for
// the run, are given to this process alone as overrides, as variables would be: nothing reaches a real server, and
// the stack's own settings stay as they are. On SIGTERM it prints what each stand-in received, for verify.sh to check,
// and stops. Bundled by verify.sh into apps/worker/dist/stack-check; never part of the image.

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

// Hebrew letters, from code points: a message holds Hebrew when one of them is in its text.
const HEBREW = new RegExp(`[${fromCodePoints(0x5d0)}-${fromCodePoints(0x5ea)}]`)

async function report(): Promise<void> {
  for (const [name, server] of [
    ["smtp2go", smtp2go],
    ["failover", failover],
  ] as const)
    for (const received of server.received) {
      const parsed = await simpleParser(received.raw)
      const text = parsed.text ?? ""
      console.log(
        [
          `received ${name}`,
          `to=${received.to.join(",")}`,
          `from=${received.from}`,
          `hebrew=${HEBREW.test(text) ? "yes" : "no"}`,
          `english=${/English paragraph/.test(text) ? "yes" : "no"}`,
          `attachments=${parsed.attachments.length}`,
          `reference=${/^\S+: [A-Z0-9]{4}-[A-Z0-9]{4}$/m.test(text) ? "yes" : "no"}`,
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
