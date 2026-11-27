import { serverHealthy } from "./health.ts"

process.exit((await serverHealthy(Number(process.env.PORT ?? 8080))) ? 0 : 1)
