ALTER TABLE "delivery_poll" ADD COLUMN "continue_token" text;--> statement-breakpoint
ALTER TABLE "delivery_poll" ADD COLUMN "window_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "delivery_poll" ADD COLUMN "window_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "unmatched_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "unmatched_delivery_source" text;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "possible_sends" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "delivery_recorded_at" timestamp with time zone;