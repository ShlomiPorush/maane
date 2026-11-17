import { randomUUID } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestDatabase, MIGRATIONS_DIR } from "../testing/db.ts"
import { migrateDatabase } from "./client.ts"

// Phase 6 removes listening mode (migrations 0029 to 0031). A database migrated up to 0028 is filled, in the old
// schema's own columns, with listening data and with live data beside it; the rest of the migrations then run. The
// listening data is gone, identified by its listening intake records; live data, live messages without a ticket
// included (one waiting for a default address, a copy, automated mail, unreadable mail), is untouched, and a live row
// that pointed at a listening message only loses that pointer.

const BEFORE = "0028_live_columns"

let database: Awaited<ReturnType<typeof createTestDatabase>>
let folder: string

beforeAll(async () => {
  // The migrations folder as it was before phase 6's removal: the journal stops at 0028.
  folder = await mkdtemp(join(tmpdir(), "maane-migrations-"))
  await cp(MIGRATIONS_DIR, folder, { recursive: true })
  const journalPath = join(folder, "meta", "_journal.json")
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as { entries: { tag: string }[] }
  const last = journal.entries.findIndex((entry) => entry.tag === BEFORE)
  if (last < 0) throw new Error(`no ${BEFORE} in the journal`)
  journal.entries = journal.entries.slice(0, last + 1)
  await writeFile(journalPath, JSON.stringify(journal))
  database = await createTestDatabase(folder)
})

afterAll(async () => {
  await database?.drop()
  if (folder) await rm(folder, { recursive: true, force: true })
})

const query = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  (await database.pool.query(text, values)).rows as T[]

describe("the removal of listening mode (migrations 0029 to 0031)", () => {
  it("deletes listening data by its intake records and leaves live data, tickets or not, as it was", async () => {
    const [org] = await query<{ id: string }>(`insert into organization (name) values ('Example Store') returning id`)
    const orgId = org?.id
    const [source] = await query<{ id: string }>(
      `insert into intake_source (tenant_id, mailbox, current) values ('example.onmicrosoft.com', 'intake@example.com', true)
       returning id`,
    )
    const sourceId = source?.id
    const [live] = await query<{ id: string }>(
      `insert into ticket (number, reference_code, organization_id, support_address, status)
       values (1, 'AAAA-BBBB', $1, 'store@example.com', 'open') returning id`,
      [orgId],
    )
    const ticketId = live?.id
    await query(`insert into ticket_participant (ticket_id, address) values ($1, 'dana@example.com')`, [ticketId])

    /** An incoming message as stage one stores it, with the old schema's listening columns when given. */
    const mail = async (values: {
      state?: string
      content?: string
      header?: string | null
      ticketId?: string | null
      duplicateOf?: string | null
      conversationId?: string | null
      wouldTicketId?: string | null
    }) => {
      const id = randomUUID()
      await query(
        `insert into message (id, direction, source_id, graph_id, folder, graph, received_at, state, content,
           message_id_header, from_address, ticket_id, duplicate_of, conversation_id, would_ticket_id)
         values ($1, 'in', $2, $3, 'inbox', '{}'::jsonb, now(), $4, $5, $6, 'dana@example.com', $7, $8, $9, $10)`,
        [
          id,
          sourceId,
          randomUUID(),
          values.state ?? "processed",
          values.content ?? "parsed",
          values.header === undefined ? `${id}@mail.example.com` : values.header,
          values.ticketId ?? null,
          values.duplicateOf ?? null,
          values.conversationId ?? null,
          values.wouldTicketId ?? null,
        ],
      )
      return id
    }
    const record = async (messageId: string, mode: string, outcome: string, extra: Record<string, string> = {}) => {
      const columns = Object.keys(extra)
      await query(
        `insert into intake_record (message_id, mode, outcome, organization_id, support_address${columns.map((c) => `, ${c}`).join("")})
         values ($1, $2, $3, $4, 'store@example.com'${columns.map((_, i) => `, $${i + 5}`).join("")})`,
        [messageId, mode, outcome, orgId, ...Object.values(extra)],
      )
    }
    const part = async (messageId: string) =>
      query(
        `insert into message_part (message_id, index, kind, size, sha256, status)
         values ($1, 0, 'attachment', 4, repeat('a', 64), 'clean')`,
        [messageId],
      )

    // Live data: a message that joined the ticket, with a file.
    const joined = await mail({ ticketId, header: "joined@mail.example.com" })
    await part(joined)
    await record(joined, "live", "joined", { ticket_id: ticketId ?? "", matched_ticket_id: ticketId ?? "" })
    // Live messages without a ticket: one waiting for a default address (stored, no record yet), a copy, automated
    // mail, and unreadable mail.
    const waiting = await mail({ state: "stored" })
    const copy = await mail({ header: "joined@mail.example.com", duplicateOf: joined })
    await record(copy, "live", "copy", { matched_message_id: joined, reason: "copy" })
    const automated = await mail({})
    await record(automated, "live", "automated")
    const unreadable = await mail({ content: "unavailable", header: null })
    await record(unreadable, "live", "unreadable", { reason: "unavailable" })

    // Listening data: a shadow conversation and its rows, a message that would have joined the live ticket (with a
    // file and its pending references), a copy of it, and a message of another conversation.
    const [conversation] = await query<{ id: string }>(
      `insert into intake_conversation (organization_id, support_address) values ($1, 'store@example.com') returning id`,
      [orgId],
    )
    const [other] = await query<{ id: string }>(
      `insert into intake_conversation (organization_id, support_address) values ($1, 'store@example.com') returning id`,
      [orgId],
    )
    const listened = await mail({
      header: "listened@mail.example.com",
      conversationId: conversation?.id,
      wouldTicketId: ticketId,
    })
    await part(listened)
    await record(listened, "listening", "joined", {
      matched_ticket_id: ticketId ?? "",
      conversation_id: conversation?.id ?? "",
    })
    const listenedCopy = await mail({ header: "listened@mail.example.com", duplicateOf: listened })
    await record(listenedCopy, "listening", "copy", { matched_message_id: listened })
    const elsewhere = await mail({ conversationId: other?.id })
    await record(elsewhere, "listening", "new_ticket", {
      conversation_id: other?.id ?? "",
      matched_conversation_id: conversation?.id ?? "",
    })
    await query(
      `insert into intake_conversation_participant (conversation_id, address) values ($1, 'dana@example.com')`,
      [conversation?.id],
    )
    await query(
      `insert into intake_conversation_link (conversation_id, linked_conversation_id, reason)
       values ($1, $2, 'sender_not_participant')`,
      [other?.id, conversation?.id],
    )
    await query(
      `insert into intake_conversation_pending (conversation_id, message_id_header, resolved_by)
       values ($1, 'listened@mail.example.com', $2)`,
      [conversation?.id, listened],
    )
    await query(
      `insert into intake_conversation_ticket_link (conversation_id, ticket_id, reason)
       values ($1, $2, 'sender_not_participant')`,
      [other?.id, ticketId],
    )
    await query(
      `insert into intake_ticket_pending (ticket_id, message_id_header, resolved_by) values ($1, 'missing@mail.example.com', $2)`,
      [ticketId, listened],
    )
    // Live rows that point at a listening message: a live copy of it, which a live record matched.
    const liveCopy = await mail({ header: "listened@mail.example.com", duplicateOf: listened })
    await record(liveCopy, "live", "copy", { matched_message_id: listened, reason: "copy" })
    await query(`update zendesk_import set went_live_at = now() where id = 1`)
    expect(await query(`select 1 from setting where key = 'intake.mode'`)).toHaveLength(1)

    // What must stay, as it is now (without the columns the migration drops).
    const liveMessages = [joined, waiting, copy, automated, unreadable]
    const snapshot = async () => ({
      ticket: await query(`select to_jsonb(t) as row from ticket t order by number`),
      participants: await query(`select ticket_id, address from ticket_participant order by address`),
      messages: await query(
        `select to_jsonb(m) - 'conversation_id' - 'would_ticket_id' as row from message m
         where id = any($1::uuid[]) order by id`,
        [liveMessages],
      ),
      records: await query(
        `select to_jsonb(r) - 'mode' - 'conversation_id' - 'matched_conversation_id' as row from intake_record r
         where message_id = any($1::uuid[]) order by message_id`,
        [liveMessages],
      ),
      parts: await query(`select message_id, sha256 from message_part where message_id = $1`, [joined]),
    })
    const before = await snapshot()

    await migrateDatabase(database.db, MIGRATIONS_DIR)

    expect(await snapshot()).toEqual(before)
    // The listening messages, their records, and their files are gone.
    const remaining = await query<{ id: string }>(`select id from message`)
    expect(remaining.map((row) => row.id).sort()).toEqual([...liveMessages, liveCopy].sort())
    expect(await query(`select 1 from message_part where message_id = $1`, [listened])).toEqual([])
    expect(
      await query(`select 1 from intake_record where message_id = any($1::uuid[])`, [
        [listened, listenedCopy, elsewhere],
      ]),
    ).toEqual([])
    // The live copy of a listening message keeps its row and its record, without the pointer.
    expect(await query(`select duplicate_of from message where id = $1`, [liveCopy])).toEqual([{ duplicate_of: null }])
    expect(
      await query(`select outcome, matched_message_id from intake_record where message_id = $1`, [liveCopy]),
    ).toEqual([{ outcome: "copy", matched_message_id: null }])
    // The listening tables and columns, the mode setting, and the old window column are gone.
    for (const table of [
      "intake_conversation",
      "intake_conversation_participant",
      "intake_conversation_link",
      "intake_conversation_pending",
      "intake_conversation_ticket_link",
      "intake_ticket_pending",
    ])
      expect(await query(`select to_regclass($1) as found`, [table])).toEqual([{ found: null }])
    const columns = await query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where (table_name = 'intake_record' and column_name in ('mode', 'conversation_id', 'matched_conversation_id'))
          or (table_name = 'message' and column_name in ('conversation_id', 'would_ticket_id'))
          or (table_name = 'zendesk_import' and column_name = 'went_live_at')`,
    )
    expect(columns).toEqual([])
    expect(await query(`select 1 from setting where key = 'intake.mode'`)).toEqual([])
    // The import window is open: only Finish import closes it, and an earlier live use does not.
    expect(await query(`select finished_at from zendesk_import`)).toEqual([{ finished_at: null }])
  })
})
