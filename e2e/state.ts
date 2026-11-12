// The run's shared state, in one owner-only file in the temporary directory: the first admin's password made for
// scripts/verify.sh's throwaway stack, the TOTP secret made by the setup test, the last TOTP step used, and the last
// documentation address given out.
import { readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE_FILE = join(tmpdir(), "maane-e2e-auth.json")

type State = { password?: string; secret?: string; lastStep?: number; addresses?: number }

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State
  } catch {
    return {}
  }
}

export function saveState(patch: State): void {
  writeFileSync(STATE_FILE, JSON.stringify({ ...loadState(), ...patch }), { mode: 0o600 })
}

/** Forgets the state of an earlier run (global setup). */
export function resetState(): void {
  rmSync(STATE_FILE, { force: true })
}
