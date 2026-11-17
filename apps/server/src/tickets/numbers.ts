// Ticket numbers (phase 6): one transaction-level advisory lock guards them. Intake takes it before it draws a number
// from the sequence and inserts its ticket; the import takes it before it checks `number_taken`, inserts a ticket with
// its Zendesk number, and moves the sequence forward (never back) in the same transaction. Both take it before any
// ticket lock (intake at the start of each message's transaction, the import at the start of each ticket's), so the
// lock order is the same everywhere and an imported number never meets a number intake drew but has not committed.

import { sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/** The name of the advisory lock; PostgreSQL keys it by the 64-bit hash of this text. */
export const TICKET_NUMBER_LOCK = "ticket-number"

/** Waits for, then holds until the transaction ends, the lock on ticket numbers. */
export async function lockTicketNumbers(tx: Pick<Tx, "execute">): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${TICKET_NUMBER_LOCK}, 0))`)
}
