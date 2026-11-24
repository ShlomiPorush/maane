import type { Db } from "@maane/server/db/client"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
