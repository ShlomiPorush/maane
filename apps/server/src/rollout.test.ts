import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = join(import.meta.dirname, "..", "..", "..")
const MIGRATIONS = join(ROOT, "apps", "server", "drizzle")
const BREAKPOINT = "--> statement-breakpoint"

interface Declaration {
  kind: "expand" | "breaking"
  name: string
}

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

function declarations(text: string): Declaration[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const match = /^(expand|breaking) (\S+)$/.exec(line)
      if (!match) throw new Error(`not a declaration: ${line}`)
      return { kind: match[1] as Declaration["kind"], name: match[2] as string }
    })
}

const NEW_TABLE = /^CREATE TABLE "(\w+)" \(\n(?:\t(?:"\w+"|CONSTRAINT "\w+") (?:(?!REFERENCES)[^\n;])*\n)+\);$/
const INDEX = /^CREATE (?:UNIQUE )?INDEX "\w+" ON "(\w+)" USING \w+ \([^\n;]*\);$/
const FOREIGN_KEY =
  /^ALTER TABLE "(\w+)" ADD CONSTRAINT "\w+" FOREIGN KEY \([^\n;]*\) REFERENCES "public"\."(\w+)"\([^\n;]*\)[^\n;]*;$/

function expandProblem(sql: string): string | null {
  const statements = sql
    .split(BREAKPOINT)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
  const created = new Set(statements.flatMap((statement) => NEW_TABLE.exec(statement)?.[1] ?? []))
  for (const statement of statements) {
    if (NEW_TABLE.test(statement)) continue
    const index = INDEX.exec(statement)
    if (index && created.has(index[1] as string)) continue
    const key = FOREIGN_KEY.exec(statement)
    if (key && created.has(key[1] as string) && created.has(key[2] as string)) continue
    return `not an expand statement: ${statement}`
  }
  return null
}

function pgBossSchema(app: string): number {
  const require = createRequire(join(ROOT, "apps", app, "package.json"))
  const manifest = JSON.parse(readFileSync(require.resolve("pg-boss/package.json"), "utf8")) as {
    pgboss: { schema: number }
  }
  return manifest.pgboss.schema
}

describe("the rollout declarations", () => {
  const declared = declarations(readFileSync(join(ROOT, "docker", "rollout.txt"), "utf8"))
  const journal = (
    JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] }
  ).entries

  it("declares every name once", () => {
    const names = declared.map((declaration) => declaration.name)
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([])
  })

  it("declare every migration in the journal, and only those or other changes", () => {
    const tags = new Set(journal.map((entry) => entry.tag))
    const migrationNames = declared.map((d) => d.name).filter((name) => /^\d{4}_/.test(name))
    expect(migrationNames.filter((name) => !tags.has(name))).toEqual([])
    expect([...tags].filter((tag) => !migrationNames.includes(tag))).toEqual([])
  })

  it("keep the journal in order, each entry after the one before", () => {
    journal.forEach((entry, i) => {
      expect(entry.idx).toBe(i)
      if (i > 0) expect(entry.when).toBeGreaterThan((journal[i - 1] as JournalEntry).when)
    })
  })

  it("allow expand only for migrations that touch no existing table", () => {
    const problems = declared
      .filter((declaration) => declaration.kind === "expand" && /^\d{4}_/.test(declaration.name))
      .flatMap((declaration) => {
        const problem = expandProblem(readFileSync(join(MIGRATIONS, `${declaration.name}.sql`), "utf8"))
        return problem ? [`${declaration.name}: ${problem}`] : []
      })
    expect(problems).toEqual([])
  })

  it("declare the pg-boss schema that the server and the worker both run as breaking, and no newer one", () => {
    const server = pgBossSchema("server")
    expect(pgBossSchema("worker")).toBe(server)
    const schemas = declared.flatMap((declaration) => {
      const match = /^pg-boss-schema-(\d+)$/.exec(declaration.name)
      return match ? [{ kind: declaration.kind, schema: Number(match[1]) }] : []
    })
    expect(schemas).toContainEqual({ kind: "breaking", schema: server })
    expect(Math.max(...schemas.map((entry) => entry.schema))).toBe(server)
  })
})

describe("the expand shape check", () => {
  const sql = (...statements: string[]) => statements.join(`${BREAKPOINT}\n`)
  const note = `CREATE TABLE "note" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"parent" uuid,\n\tCONSTRAINT "note_form" CHECK ("note"."id" is not null)\n);`
  const noteTag = `CREATE TABLE "note_tag" (\n\t"note_id" uuid NOT NULL\n);`

  it("passes new tables with their indexes and a foreign key between them, as drizzle-kit writes them", () => {
    expect(
      expandProblem(
        sql(
          note,
          noteTag,
          `ALTER TABLE "note_tag" ADD CONSTRAINT "note_tag_note_id_note_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id") ON DELETE cascade ON UPDATE no action;`,
          `CREATE UNIQUE INDEX "note_parent_idx" ON "note" USING btree ("parent");`,
        ),
      ),
    ).toBeNull()
  })

  it.each([
    ["a dropped column", `ALTER TABLE "ticket" DROP COLUMN "subject";`],
    ["a column added to an existing table", `ALTER TABLE "ticket" ADD COLUMN "note" text;`],
    ["an index on an existing table", `CREATE INDEX "ticket_note_idx" ON "ticket" USING btree ("subject");`],
    [
      "a foreign key to an existing table",
      `ALTER TABLE "note" ADD CONSTRAINT "note_ticket_fk" FOREIGN KEY ("id") REFERENCES "public"."ticket"("id");`,
    ],
    ["a reference inside a new table", `CREATE TABLE "x" (\n\t"ticket_id" uuid REFERENCES "ticket"("id")\n);`],
    ["a table built on another table", `CREATE TABLE "x" (\n\t"id" uuid\n) INHERITS ("ticket");`],
    ["a second statement in one segment", `${noteTag}\nALTER TABLE "ticket" ADD COLUMN "note" text;`],
    ["a statement written by hand in another layout", `CREATE TABLE "x" ("id" uuid);`],
    ["a new type", `CREATE TYPE "public"."level" AS ENUM('low', 'high');`],
    ["a data change", `UPDATE "ticket" SET "subject" = '';`],
  ])("refuses %s", (_, statement) => {
    expect(expandProblem(sql(note, statement))).toMatch(/not an expand statement/)
  })
})
