import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import pg from "pg"
import * as schema from "./schema.ts"

export type Db = NodePgDatabase<typeof schema>

export interface Database {
  pool: pg.Pool
  db: Db
  close(): Promise<void>
}

/** One pool per process. The connection string, with its password, is never logged. */
export function openDatabase(url: string, max = 10): Database {
  const pool = new pg.Pool({ connectionString: url, max })
  // An idle client's error (the database restarted) must not crash the process; the next query reconnects.
  pool.on("error", () => {})
  const db = drizzle(pool, { schema })
  return { pool, db, close: () => pool.end() }
}

/** Applies the generated migrations in `dir`. Runs on server start, before anything else touches the database. */
export async function migrateDatabase(db: Db, dir: string): Promise<void> {
  await migrate(db, { migrationsFolder: dir })
}
