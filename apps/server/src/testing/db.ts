import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { type Database, migrateDatabase, openDatabase } from "../db/client.ts"

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url))

/**
 * A new, migrated database for one test file, inside the disposable PostgreSQL that scripts/verify.sh starts
 * (MAANE_TEST_DATABASE_URL, with a password generated for the run). Dropped by `drop()`.
 */
export async function createTestDatabase(): Promise<Database & { url: string; drop(): Promise<void> }> {
  const base = process.env.MAANE_TEST_DATABASE_URL
  if (!base) throw new Error("MAANE_TEST_DATABASE_URL is not set: integration tests run only from scripts/verify.sh")
  const name = `maane_test_${randomBytes(6).toString("hex")}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()
  const url = new URL(base)
  url.pathname = `/${name}`
  const database = openDatabase(url.toString(), 5)
  await migrateDatabase(database.db, MIGRATIONS_DIR)
  return {
    ...database,
    url: url.toString(),
    async drop() {
      await database.close()
      const client = new pg.Client({ connectionString: base })
      await client.connect()
      await client.query(`drop database if exists ${name} with (force)`)
      await client.end()
    },
  }
}

/** A key for tests, new on every run. */
export const testKey = () => randomBytes(32).toString("hex")
