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

export function openDatabase(url: string, max = 10, options: { statementTimeoutMs?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max, statement_timeout: options.statementTimeoutMs })
  // Without a listener, one idle connection lost when PostgreSQL restarts would crash the whole process.
  pool.on("error", () => {})
  const db = drizzle(pool, { schema })
  return { pool, db, close: () => pool.end() }
}

export async function migrateDatabase(db: Db, dir: string): Promise<void> {
  await migrate(db, { migrationsFolder: dir })
}
