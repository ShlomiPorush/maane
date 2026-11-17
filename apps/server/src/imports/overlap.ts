// The same mail through both paths (phase 6): while the Microsoft 365 rules move from Zendesk to Maane, one customer
// mail may reach Maane through intake and also come in through the import as a Zendesk comment. Nothing is ever hidden:
// when a message intake received and an imported comment on the same ticket share their Message-ID and sender, both
// stay visible and the ticket is flagged `possible_duplicate` for a person to look at, whichever arrived first. The
// imported comment's Message-ID is read only here (`message.zendesk_message_id`), never by threading or copies.

import { sql } from "drizzle-orm"
import type { Db } from "../db/client.ts"

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

/**
 * Flags the ticket `possible_duplicate` (once; nothing removes it) when one of its messages from intake and one of its
 * imported comments share Message-ID and sender. Called with the ticket locked: by intake after it attached a message,
 * and by the import after it wrote the ticket's comments.
 */
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
