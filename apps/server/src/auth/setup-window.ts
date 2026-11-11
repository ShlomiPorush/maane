import { SETUP_WINDOW_MS } from "@maane/shared"

/**
 * The first-run setup window: open for SETUP_WINDOW_MS after the server starts, measured on a monotonic clock, so a
 * change of the wall clock neither opens nor extends it. A restart opens a new window (owner's decision). Whether a
 * user exists is checked separately, on every setup request.
 */
export class SetupWindow {
  readonly #startedAt: number
  readonly #now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
    this.#startedAt = now()
  }

  isOpen(): boolean {
    return this.#now() - this.#startedAt < SETUP_WINDOW_MS
  }

  /** Milliseconds until the window closes, 0 once closed. */
  remainingMs(): number {
    return Math.max(0, SETUP_WINDOW_MS - (this.#now() - this.#startedAt))
  }
}
