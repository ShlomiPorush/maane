ALTER TABLE "message" ADD COLUMN "zendesk_message_id" text;--> statement-breakpoint
ALTER TABLE "zendesk_import" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "message_zendesk_message_id_idx" ON "message" USING hash ("zendesk_message_id");