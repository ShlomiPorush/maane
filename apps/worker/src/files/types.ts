import type { Db } from "@maane/server/db/client"

/** A transaction of Maane's connection. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
