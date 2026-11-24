import { SETUP_WINDOW_MS } from "@maane/shared"

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

  remainingMs(): number {
    return Math.max(0, SETUP_WINDOW_MS - (this.#now() - this.#startedAt))
  }
}
