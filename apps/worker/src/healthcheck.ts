import { readFile } from "node:fs/promises"
import { HEARTBEAT_FILE, HEARTBEAT_MAX_AGE_MS } from "./jobs.ts"

const text = await readFile(HEARTBEAT_FILE, "utf8").catch(() => "")
const age = Date.now() - Number(text)
process.exit(text && Number.isFinite(age) && age >= 0 && age < HEARTBEAT_MAX_AGE_MS ? 0 : 1)
