import { sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export const TICKET_NUMBER_LOCK = "ticket-number"

export async function lockTicketNumbers(tx: Pick<Tx, "execute">): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${TICKET_NUMBER_LOCK}, 0))`)
}
