ALTER TABLE "outbox" DROP CONSTRAINT "outbox_report_without_recipient_message_id_fk";
--> statement-breakpoint
ALTER TABLE "outbox" DROP COLUMN "report_without_recipient";