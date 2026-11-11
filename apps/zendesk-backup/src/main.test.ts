import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { insideGitWorkTree, main } from "./main.ts"
import { type PromptInput, readHidden } from "./prompt.ts"

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "maane-cli-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class FakeTerminal extends EventEmitter implements PromptInput {
  isTTY = true
  raw: boolean[] = []
  setRawMode(mode: boolean) {
    this.raw.push(mode)
    return this
  }
  setEncoding() {
    return this
  }
  resume() {
    return this
  }
  pause() {
    return this
  }
}

function capture() {
  let text = ""
  return {
    write: (chunk: string) => {
      text += chunk
    },
    text: () => text,
  }
}

function io(stdin: PromptInput = new FakeTerminal()) {
  const stdout = capture()
  const stderr = capture()
  return { io: { stdin, stdout, stderr }, stdout, stderr }
}

describe("command line", () => {
  it("prints the usage", async () => {
    const run = io()
    expect(await main(["--help"], run.io)).toBe(0)
    expect(run.stdout.text()).toContain("zendesk-backup backup --subdomain NAME")
  })

  it("refuses unknown commands and bad arguments", async () => {
    expect(await main(["restore", "--out", dir], io().io)).toBe(2)
    const run = io()
    expect(await main(["backup", "--subdomain", "a.b", "--email", "agent@example.com", "--out", dir], run.io)).toBe(2)
    expect(run.stderr.text()).toContain("--subdomain")
    expect(await main(["backup", "--subdomain", "acme", "--email", "nobody", "--out", dir], io().io)).toBe(2)
    expect(await main(["check"], io().io)).toBe(2)
  })

  it("refuses an output folder inside a Git working tree", async () => {
    await mkdir(join(dir, "repo", ".git"), { recursive: true })
    const run = io()
    expect(await main(["check", "--out", join(dir, "repo", "archive")], run.io)).toBe(2)
    expect(run.stderr.text()).toContain("inside a Git working tree")
    expect(await insideGitWorkTree(join(dir, "elsewhere"))).toBe(false)
  })

  it("reads the token from a terminal only", async () => {
    const notTerminal = Object.assign(new FakeTerminal(), { isTTY: false })
    const run = io(notTerminal)
    const args = ["backup", "--subdomain", "acme", "--email", "agent@example.com", "--out", join(dir, "a")]
    expect(await main(args, run.io)).toBe(1)
    expect(run.stderr.text()).toContain("read from a terminal only")
  })

  it("reports an incomplete archive and fails", async () => {
    const run = io()
    expect(await main(["check", "--out", dir], run.io)).toBe(1)
    expect(run.stdout.text()).toContain("Archive check: INCOMPLETE")
  })
})

describe("hidden prompt", () => {
  it("reads what is typed without echoing it, and handles backspace", async () => {
    const terminal = new FakeTerminal()
    const output = capture()
    const value = readHidden("Token: ", terminal, output)
    terminal.emit("data", "ab")
    terminal.emit("data", `${String.fromCharCode(127)}c\r`)
    expect(await value).toBe("ac")
    expect(output.text()).toBe("Token: \n")
    expect(terminal.raw).toEqual([true, false])
  })

  it("stops on Ctrl+C", async () => {
    const terminal = new FakeTerminal()
    const value = readHidden("Token: ", terminal, capture())
    terminal.emit("data", String.fromCharCode(3))
    await expect(value).rejects.toThrow("cancelled")
  })
})
