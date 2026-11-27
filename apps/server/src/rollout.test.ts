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

const identifier = String.raw`(?:"(\w+)"\.)?"(\w+)"`

function tableOf(match: RegExpExecArray | RegExpMatchArray, at: number): string {
  return `${match[at] ?? "public"}.${match[at + 1]}`
}

function expandProblem(sql: string): string | null {
  const statements = sql
    .split(BREAKPOINT)
    .flatMap((segment) => segment.split(";"))
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement !== "")
  const created = new Set(
    statements.flatMap((statement) => {
      const match = new RegExp(String.raw`^CREATE TABLE ${identifier} \(`, "i").exec(statement)
      return match ? [tableOf(match, 1)] : []
    }),
  )
  for (const statement of statements) {
    const references = statement.match(/\bREFERENCES\b/gi)?.length ?? 0
    const targets = [...statement.matchAll(new RegExp(String.raw`\bREFERENCES ${identifier}`, "gi"))].map((m) =>
      tableOf(m, 1),
    )
    if (targets.length !== references) return `a reference the check cannot read: ${statement}`
    const outside = targets.find((table) => !created.has(table))
    if (outside) return `references the existing table ${outside}: ${statement}`
    if (new RegExp(String.raw`^CREATE TABLE ${identifier} \(`, "i").test(statement)) continue
    if (new RegExp(String.raw`^CREATE TYPE ${identifier} AS ENUM ?\(`, "i").test(statement)) continue
    const index = new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX "\w+" ON ${identifier}`, "i").exec(statement)
    if (index && created.has(tableOf(index, 1))) continue
    const constraint = new RegExp(`^ALTER TABLE ${identifier} ADD CONSTRAINT `, "i").exec(statement)
    if (constraint && created.has(tableOf(constraint, 1))) continue
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
  const sql = (...statements: string[]) => statements.join(`\n${BREAKPOINT}\n`)

  it("passes a new table with its index, its constraint, and a new type", () => {
    expect(
      expandProblem(
        sql(
          `CREATE TYPE "public"."level" AS ENUM('low', 'high');`,
          `CREATE TABLE "note" (\n\t"id" uuid PRIMARY KEY NOT NULL,\n\t"parent" uuid\n);`,
          `CREATE TABLE "note_tag" ("note_id" uuid NOT NULL);`,
          `ALTER TABLE "note_tag" ADD CONSTRAINT "note_tag_note_fk" FOREIGN KEY ("note_id") REFERENCES "public"."note"("id");`,
          `CREATE INDEX "note_parent_idx" ON "note" USING btree ("parent");`,
        ),
      ),
    ).toBeNull()
  })

  it.each([
    ["a dropped column", `ALTER TABLE "ticket" DROP COLUMN "subject";`],
    ["a column added to an existing table", `ALTER TABLE "ticket" ADD COLUMN "note" text;`],
    ["an index on an existing table", `CREATE INDEX "ticket_note_idx" ON "ticket" USING btree ("subject");`],
    ["a dropped table", `DROP TABLE "ticket";`],
    ["a data change", `UPDATE "ticket" SET "subject" = '';`],
    ["a value added to a type", `ALTER TYPE "public"."status" ADD VALUE 'held';`],
  ])("refuses %s", (_, statement) => {
    expect(expandProblem(statement)).not.toBeNull()
  })

  it("refuses a new table with a foreign key to an existing table", () => {
    expect(
      expandProblem(
        sql(
          `CREATE TABLE "note" ("ticket_id" uuid NOT NULL);`,
          `ALTER TABLE "note" ADD CONSTRAINT "note_ticket_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id");`,
        ),
      ),
    ).toMatch(/existing table public\.ticket/)
    expect(expandProblem(`CREATE TABLE "note" ("ticket_id" uuid REFERENCES "ticket"("id"));`)).toMatch(/ticket/)
    expect(expandProblem(`CREATE TABLE "note" ("ticket_id" uuid REFERENCES ticket(id));`)).toMatch(/cannot read/)
  })

  it("refuses a statement on an existing table hidden after a new table in one segment", () => {
    expect(
      expandProblem(
        `CREATE TABLE "note" ("id" uuid PRIMARY KEY NOT NULL);\nALTER TABLE "ticket" ADD COLUMN "note" text;`,
      ),
    ).toMatch(/not an expand statement: ALTER TABLE "ticket"/)
  })

  it("refuses an index on an existing table that shares a new table's name in another schema", () => {
    expect(
      expandProblem(
        sql(
          `CREATE TABLE "archive"."ticket" ("id" uuid PRIMARY KEY NOT NULL);`,
          `CREATE INDEX "ticket_subject_idx" ON "public"."ticket" USING btree ("subject");`,
        ),
      ),
    ).not.toBeNull()
  })

  it("refuses CREATE TABLE IF NOT EXISTS, which may name an existing table", () => {
    expect(expandProblem(`CREATE TABLE IF NOT EXISTS "ticket" ("id" uuid PRIMARY KEY NOT NULL);`)).not.toBeNull()
  })
})
