ALTER TABLE "intake_cursor" DROP CONSTRAINT "intake_cursor_kind";--> statement-breakpoint
ALTER TABLE "intake_cursor" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "retry_attempts";--> statement-breakpoint
ALTER TABLE "outbox" DROP COLUMN "attempts";