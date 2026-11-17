-- Custom migration (drizzle-kit generate --custom): phase 6, Maane is live from the first moment (owner's decision,
-- 2026-11-17), so listening mode is gone. This removes the data only listening made, before the next migration drops its
-- tables and columns. Listening-only data is identified by its listening intake records, never by "no ticket": live
-- messages waiting for a default address, copies, automated mail, and unreadable mail have no ticket either, and stay
-- as they are. No production database holds any: Maane was never deployed before this version.
-- The import window no longer closes by going live: `went_live_at`, which 0025 also inferred from live use, is not
-- carried over; the window closes only when an admin presses Finish import (`finished_at`).
CREATE TEMPORARY TABLE "listening_message" AS
SELECT "message_id" AS "id" FROM "intake_record" WHERE "mode" = 'listening';
--> statement-breakpoint
-- Live rows that point at a listening message (a live copy of one, a live record that matched one) keep their own
-- record and lose only that pointer.
UPDATE "intake_record" SET "matched_message_id" = NULL
WHERE "mode" = 'live' AND "matched_message_id" IN (SELECT "id" FROM "listening_message");
--> statement-breakpoint
UPDATE "message" SET "duplicate_of" = NULL
WHERE "duplicate_of" IN (SELECT "id" FROM "listening_message")
  AND "id" NOT IN (SELECT "id" FROM "listening_message");
--> statement-breakpoint
-- The shadow tables hold listening data only.
DELETE FROM "intake_conversation_ticket_link";
--> statement-breakpoint
DELETE FROM "intake_conversation_pending";
--> statement-breakpoint
DELETE FROM "intake_conversation_link";
--> statement-breakpoint
DELETE FROM "intake_conversation_participant";
--> statement-breakpoint
DELETE FROM "intake_ticket_pending";
--> statement-breakpoint
DELETE FROM "message_part" WHERE "message_id" IN (SELECT "id" FROM "listening_message");
--> statement-breakpoint
DELETE FROM "intake_record" WHERE "message_id" IN (SELECT "id" FROM "listening_message");
--> statement-breakpoint
DELETE FROM "message" WHERE "id" IN (SELECT "id" FROM "listening_message");
--> statement-breakpoint
DELETE FROM "intake_conversation";
--> statement-breakpoint
DROP TABLE "listening_message";
--> statement-breakpoint
-- The intake mode setting is gone with the mode.
DELETE FROM "setting" WHERE "key" = 'intake.mode';
--> statement-breakpoint
-- Comments imported before 0028 added the column get their Message-ID from their `zendesk` JSON, which holds the value the
-- source recorded, read as messageIds() in apps/worker/src/intake/parse.ts reads it when a run writes the column: the
-- first `<...>` that holds no `<`, `>`, or whitespace, else the whole value trimmed when it holds no whitespace, and
-- no change of case. Whitespace is JavaScript's (`\s` and trim(), the same set), spelled out by code point because
-- PostgreSQL's classes depend on the locale. The import keeps at most 998 characters of a Message-ID (map.ts), so
-- messageIds()'s length limit drops nothing here.
UPDATE "message" AS "m" SET "zendesk_message_id" = CASE
    WHEN "s"."value" ~ '<[^<>\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+>'
      THEN (regexp_match("s"."value", '<([^<>\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+)>'))[1]
    WHEN "s"."trimmed" <> '' AND "s"."trimmed" !~ '[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]'
      THEN "s"."trimmed"
  END
FROM (
  SELECT "id", "zendesk"->'email'->>'messageId' AS "value",
    regexp_replace(
      "zendesk"->'email'->>'messageId',
      '^[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+|[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+$',
      '', 'g'
    ) AS "trimmed"
  FROM "message"
  WHERE "zendesk_key" IS NOT NULL AND "zendesk"->'email'->>'kind' = 'recorded'
    AND jsonb_typeof("zendesk"->'email'->'messageId') = 'string'
) AS "s"
WHERE "m"."id" = "s"."id";
