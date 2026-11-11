import { stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Archive, type CheckResult, checkArchive, runBackup, tokenAuthorization, ZendeskClient } from "@maane/zendesk"
import { type PromptInput, readHidden } from "./prompt.ts"

export const USAGE = `Usage:
  zendesk-backup backup --subdomain NAME --email ADDRESS --out DIR [--max-file-mb N]
  zendesk-backup check --out DIR

backup  Saves the Zendesk account NAME.zendesk.com into DIR, or continues an earlier backup there.
        Asks for the API token in the terminal; the token is never written anywhere.
        Then checks the archive.
check   Reads the archive in DIR without any access to Zendesk and reports what it holds.

DIR must be outside every Git working tree: the archive holds customer data.
--max-file-mb  Largest file to download (default 100). Larger files are recorded as failed.`

export interface Io {
  stdin: PromptInput
  stdout: { write(text: string): unknown }
  stderr: { write(text: string): unknown }
}

/** Runs the command line. Returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  const say = (line: string) => io.stderr.write(`${line}\n`)
  let parsed: ReturnType<typeof parse>
  try {
    parsed = parse(argv)
  } catch (error) {
    say(`error: ${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (parsed.command === "help") {
    io.stdout.write(`${USAGE}\n`)
    return 0
  }

  const out = resolve(parsed.out)
  if (await insideGitWorkTree(out)) {
    say(
      `error: ${out} is inside a Git working tree. Choose a folder outside every repository: the archive holds customer data.`,
    )
    return 2
  }

  try {
    if (parsed.command === "backup") {
      const token = await readHidden("Zendesk API token: ", io.stdin, io.stderr)
      if (!token) throw new Error("no token entered")
      const client = new ZendeskClient({
        apiOrigin: `https://${parsed.subdomain}.zendesk.com`,
        authorization: tokenAuthorization(parsed.email, token),
      })
      const result = await runBackup({
        client,
        archive: new Archive(out),
        maxFileBytes: parsed.maxFileMb * 1024 * 1024,
        log: say,
      })
      say(`Backup run ${result.run} finished. Changes up to ${result.coveredUntil ?? "(unknown)"} are in the archive.`)
    }
    const check = await checkArchive(out)
    report(check, io)
    return check.problems.length > 0 ? 1 : 0
  } catch (error) {
    say(`error: ${(error as Error).message}`)
    return 1
  }
}

type Parsed =
  | { command: "help" }
  | { command: "check"; out: string }
  | { command: "backup"; out: string; subdomain: string; email: string; maxFileMb: number }

function parse(argv: string[]): Parsed {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      subdomain: { type: "string" },
      email: { type: "string" },
      out: { type: "string" },
      "max-file-mb": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || command === "help" || command === undefined) return { command: "help" }
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`)
  if (command !== "backup" && command !== "check") throw new Error(`unknown command: ${command}`)
  if (!values.out) throw new Error("--out is required")
  if (command === "check") return { command, out: values.out }

  const subdomain = values.subdomain ?? ""
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(subdomain)) throw new Error("--subdomain must be the NAME of NAME.zendesk.com")
  const email = values.email ?? ""
  if (!/^[^\s@]+@[^\s@]+$/.test(email))
    throw new Error("--email must be the address of the Zendesk user the token belongs to")
  const maxFileMb = Number(values["max-file-mb"] ?? 100)
  if (!Number.isInteger(maxFileMb) || maxFileMb < 1 || maxFileMb > 4096) {
    throw new Error("--max-file-mb must be a whole number from 1 to 4096")
  }
  return { command, out: values.out, subdomain: subdomain.toLowerCase(), email, maxFileMb }
}

/** True when the path, or the nearest folder above it that exists, belongs to a Git working tree. */
export async function insideGitWorkTree(path: string): Promise<boolean> {
  let current = resolve(path)
  for (;;) {
    try {
      await stat(join(current, ".git"))
      return true
    } catch {
      // keep looking upwards
    }
    const parent = dirname(current)
    if (parent === current) return false
    current = parent
  }
}

function report(check: CheckResult, io: Io): void {
  const c = check.counts
  const lines = [
    `Archive check: ${check.problems.length === 0 ? "complete" : "INCOMPLETE"}`,
    `  Changes covered until: ${check.coveredUntil ?? "(unknown)"}`,
    `  Tickets: ${c.tickets} (deleted in Zendesk: ${c.deletedTickets}, deleted before their newest version was saved: ${c.goneTickets})`,
    `  Comments: ${c.comments} (internal notes: ${c.internalNotes})`,
    `  Users: ${c.users}  Organizations: ${c.organizations}`,
    `  Files saved: ${c.filesOk} (inline images: ${c.inlineImages})  Files failed: ${c.filesFailed}`,
    `  JSON files read: ${c.jsonFiles}`,
  ]
  for (const problem of check.problems) lines.push(`  problem: ${problem}`)
  const shown = check.warnings.slice(0, 50)
  for (const warning of shown) lines.push(`  note: ${warning}`)
  if (check.warnings.length > shown.length) lines.push(`  ... and ${check.warnings.length - shown.length} more notes`)
  io.stdout.write(`${lines.join("\n")}\n`)
}
