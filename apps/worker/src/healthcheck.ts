import { readFile } from "node:fs/promises"
import { HEARTBEAT_FILE, HEARTBEAT_MAX_AGE_MS } from "./jobs.ts"

// The container health check: healthy while the queue ran the heartbeat job within the last few minutes. A worker
// that is up but cannot reach the database, or whose queue stopped, turns unhealthy. Right after start, before the
// first heartbeat, Docker's start period covers the wait.

const text = await readFile(HEARTBEAT_FILE, "utf8").catch(() => "")
const age = Date.now() - Number(text)
process.exit(text && Number.isFinite(age) && age < HEARTBEAT_MAX_AGE_MS ? 0 : 1)
