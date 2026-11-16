import { Archive, runBackup, ZendeskClient } from "@maane/zendesk"
import { StandInZendesk } from "@maane/zendesk/testing/stand-in"
import { MARKERS } from "./clamd.ts"

// An invented Zendesk account for the import's tests (plan 5.1): the stand-in Zendesk API of phase 0 with brands,
// users with roles, ticket fields, and tickets whose records and comments carry what the import maps, backed up into
// an archive by the real backup run. Every person and address is invented (example.com); Hebrew is built from code
// points.

const words = (...points: number[]) => String.fromCodePoint(...points)
/** "Order did not arrive" and "Hello, the package was not received". */
export const HEBREW_SUBJECT = words(
  0x5d4,
  0x5d6,
  0x5de,
  0x5e0,
  0x5d4,
  0x20,
  0x5dc,
  0x5d0,
  0x20,
  0x5d4,
  0x5d2,
  0x5d9,
  0x5e2,
  0x5d4,
)
export const HEBREW_BODY = words(
  0x5e9,
  0x5dc,
  0x5d5,
  0x5dd,
  0x2c,
  0x20,
  0x5d4,
  0x5d7,
  0x5d1,
  0x5d9,
  0x5dc,
  0x5d4,
  0x20,
  0x5dc,
  0x5d0,
  0x20,
  0x5d4,
  0x5d2,
  0x5d9,
  0x5e2,
  0x5d4,
)

export const BRANDS = { mapped: 100, other: 200 } as const
export const AGENT = { id: 10, name: "Dana Agent", email: "dana.agent@example.com" }

const at = (minute: number) => new Date(Date.UTC(2025, 4, 1, 9, minute)).toISOString()

/**
 * The stand-in, set up before its first backup. Its own tickets 1 to 5 (open, pending, solved, deleted, gone) get
 * records; ticket 6 has a brand nobody mapped; ticket 7 is a follow-up of ticket 1 and holds a NUL character.
 */
export function standInAccount(): StandInZendesk {
  const zendesk = new StandInZendesk()
  for (const user of zendesk.users) user.role = "end-user"
  zendesk.users.push({ ...AGENT, role: "agent" })
  zendesk.collectionRecords.set("brands", [
    { id: BRANDS.mapped, name: "Example Store" },
    { id: BRANDS.other, name: "Example Outlet" },
  ])
  zendesk.collectionRecords.set("ticket_fields", [
    { id: 500, title: "Order number", type: "text" },
    { id: 501, title: "Plan", type: "tagger", custom_field_options: [{ name: "Gold plan", value: "plan_gold" }] },
  ])
  const record = (id: number, value: Record<string, unknown>) => {
    const ticket = zendesk.tickets.get(id)
    if (ticket) ticket.record = value
  }
  record(1, {
    subject: HEBREW_SUBJECT,
    brand_id: BRANDS.mapped,
    requester_id: 2,
    email_cc_ids: [3],
    follower_ids: [AGENT.id],
    tags: ["vip", "billing"],
    custom_fields: [
      { id: 500, value: "A-17" },
      { id: 501, value: "plan_gold" },
    ],
    created_at: at(0),
    recipient: "store@example.com",
  })
  const ticket1 = zendesk.tickets.get(1)
  if (ticket1) {
    const [question, note, answer] = ticket1.comments
    if (question)
      question.extra = {
        author_id: 2,
        created_at: at(1),
        html_body: `<p>${HEBREW_BODY}</p>`,
        plain_body: HEBREW_BODY,
        via: {
          channel: "email",
          source: {
            from: { address: "user2@example.com", name: "User 2", original_recipients: ["store@example.com"] },
            to: { address: "store@example.com", name: "Example Store", email_ccs: ["user3@example.com"] },
            rel: null,
          },
        },
        metadata: { system: { message_id: "<question-1@mail.example.com>" } },
      }
    if (note) note.extra = { author_id: AGENT.id, created_at: at(2) }
    if (answer) answer.extra = { author_id: AGENT.id, created_at: at(3), html_body: "<p>Answer</p>" }
    // Ticket 3 was merged into ticket 1.
    ticket1.audits = [
      { id: 7001, ticket_id: 1, via: { channel: "web", source: { rel: "merge", from: { ticket_id: 3 } } }, events: [] },
    ]
  }
  record(2, { brand_id: BRANDS.mapped, requester_id: 3, created_at: at(10) })
  const ticket2 = zendesk.tickets.get(2)
  ticket2?.comments.push({
    id: 22,
    public: true,
    body: `Order details ${MARKERS.infected}`,
    files: [],
    extra: { author_id: 3, created_at: at(12) },
  })
  if (ticket2?.comments[0]) ticket2.comments[0].extra = { author_id: 3, created_at: at(11) }
  record(3, { brand_id: BRANDS.mapped, requester_id: 2, tags: ["billing"], created_at: at(20) })
  // A walk-in customer without an address, whose name holds a NUL character, and a file name with one.
  zendesk.users.push({ id: 4, name: `Walk-in${String.fromCharCode(0)} Customer`, email: null, role: "end-user" })
  const ticket3 = zendesk.tickets.get(3)
  const lost = ticket3?.comments[0]
  if (lost) {
    lost.extra = { author_id: 4, created_at: at(21) }
    const file = lost.files[0]
    if (file) file.name = `lost${String.fromCharCode(0)}.txt`
  }
  record(4, { brand_id: BRANDS.mapped, requester_id: 2 })
  record(5, { brand_id: BRANDS.mapped, requester_id: 2 })
  zendesk.addTicket(6, "open", [{ id: 61, public: true, body: "Outlet question", files: [] }], false, {
    record: { brand_id: BRANDS.other, requester_id: 3 },
  })
  zendesk.addTicket(
    7,
    "new",
    [
      {
        id: 71,
        public: true,
        body: `Follow-up${String.fromCharCode(0)} question`,
        files: [],
        extra: { author_id: 2, created_at: at(40) },
      },
    ],
    false,
    {
      record: {
        brand_id: BRANDS.mapped,
        requester_id: 2,
        created_at: at(40),
        via: { channel: "web", source: { rel: "follow_up", from: { ticket_id: 1 } } },
      },
    },
  )
  return zendesk
}

/** One backup run of the stand-in into the archive folder, as the command line runs it (files up to 1 KiB). */
export async function backupInto(zendesk: StandInZendesk, dir: string, maxFileBytes = 1024): Promise<void> {
  const client = new ZendeskClient({
    apiOrigin: zendesk.apiOrigin,
    authorization: zendesk.authorization,
    allowHttp: true,
    fileHostAllowed: (host) => host === "127.0.0.1",
    sleep: async () => {},
  })
  await runBackup({ client, archive: new Archive(dir), maxFileBytes })
}
