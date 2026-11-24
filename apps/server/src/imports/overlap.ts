import { sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export async function flagSameMail(tx: Pick<Tx, "execute">, ticketId: string): Promise<void> {
  await tx.execute(sql`
    update ticket set review_flags = array_append(review_flags, 'possible_duplicate')
    where id = ${ticketId} and not ('possible_duplicate' = any(review_flags))
      and exists (
        select 1 from message received
        join message imported on imported.ticket_id = received.ticket_id
          and imported.zendesk_message_id = received.message_id_header
          and imported.from_address = received.from_address
        where received.ticket_id = ${ticketId} and received.direction = 'in' and received.zendesk_key is null
          and imported.zendesk_key is not null
      )`)
}
