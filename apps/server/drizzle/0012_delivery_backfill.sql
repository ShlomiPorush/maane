-- Plan 3.3, review D5: the columns 0010 and 0011 added, filled for replies sent before this version.
-- SMTP2GO's queue ID, read from the stored final reply as queueIdOf reads it (apps/server/src/delivery/service.ts).
UPDATE "outbox_recipient"
SET "provider_id" = (regexp_match("response", '(?:^|\s)id=([A-Za-z0-9._-]{1,100})(?:\s|$)'))[1]
WHERE "provider_id" IS NULL AND "state" = 'accepted' AND "provider" = 'smtp2go' AND "response" IS NOT NULL;
--> statement-breakpoint
-- When the recipient was accepted: its last change before this version was its acceptance.
UPDATE "outbox_recipient" SET "accepted_at" = "updated_at" WHERE "accepted_at" IS NULL AND "state" = 'accepted';
--> statement-breakpoint
-- How many attempts may have reached an accepted or unknown recipient is not known for a reply sent before this
-- version: an unknown one, or one whose reply was ever sent again, gets 2, which never allows a match by Message-ID;
-- an accepted one of a reply sent once gets 1 (an event finds it by its queue ID anyway).
UPDATE "outbox_recipient" AS "r"
SET "possible_sends" = CASE WHEN "r"."state" = 'unknown' OR "o"."attempts" > 1 THEN 2 ELSE 1 END
FROM "outbox" AS "o"
WHERE "o"."message_id" = "r"."message_id" AND "r"."possible_sends" = 0 AND "r"."state" IN ('accepted', 'unknown');
--> statement-breakpoint
UPDATE "outbox_recipient" SET "delivery_recorded_at" = "delivery_at"
WHERE "delivery_recorded_at" IS NULL AND "delivery" IS NOT NULL;
--> statement-breakpoint
-- A report recorded without a recipient becomes an unmatched delivery event of the reply.
UPDATE "outbox" SET "unmatched_delivery_at" = "updated_at", "unmatched_delivery_source" = 'report'
WHERE "report_without_recipient" IS NOT NULL AND "unmatched_delivery_at" IS NULL;
