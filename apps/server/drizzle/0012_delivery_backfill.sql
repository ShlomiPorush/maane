-- Plan 3.3, review D5: the columns 0010 and 0011 added, filled for replies sent before this version.
-- SMTP2GO's queue ID, read from the stored final reply as queueIdOf reads it (apps/server/src/delivery/service.ts).
UPDATE "outbox_recipient"
SET "provider_id" = (regexp_match("response", '(?:^|\s)id=([A-Za-z0-9._-]{1,100})(?:\s|$)'))[1]
WHERE "provider_id" IS NULL AND "state" = 'accepted' AND "provider" = 'smtp2go' AND "response" IS NOT NULL;
--> statement-breakpoint
-- When the recipient was accepted: its last change before this version was its acceptance.
UPDATE "outbox_recipient" SET "accepted_at" = "updated_at" WHERE "accepted_at" IS NULL AND "state" = 'accepted';
--> statement-breakpoint
-- At least one attempt may have reached an accepted or unknown recipient.
UPDATE "outbox_recipient" SET "possible_sends" = 1
WHERE "possible_sends" = 0 AND "state" IN ('accepted', 'unknown');
--> statement-breakpoint
UPDATE "outbox_recipient" SET "delivery_recorded_at" = "delivery_at"
WHERE "delivery_recorded_at" IS NULL AND "delivery" IS NOT NULL;
--> statement-breakpoint
-- A report recorded without a recipient becomes an unmatched delivery event of the reply.
UPDATE "outbox" SET "unmatched_delivery_at" = "updated_at", "unmatched_delivery_source" = 'report'
WHERE "report_without_recipient" IS NOT NULL AND "unmatched_delivery_at" IS NULL;
