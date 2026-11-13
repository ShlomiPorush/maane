import { errorFacts, log } from "@maane/server/log"
import { startWorker } from "./main.ts"

// The worker process: started as configured, stopped gracefully on SIGTERM or SIGINT.

async function main(): Promise<void> {
  const worker = await startWorker()
  const stop = async (signal: string) => {
    log.info("worker stopping", { signal })
    await worker.stop()
    process.exit(0)
  }
  process.once("SIGTERM", () => void stop("SIGTERM"))
  process.once("SIGINT", () => void stop("SIGINT"))
}

main().catch((error) => {
  log.error("worker failed to start", {
    ...errorFacts(error),
    reason: error instanceof Error && error.name === "ConfigError" ? error.message : null,
  })
  process.exit(1)
})
