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
