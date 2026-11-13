CREATE TABLE "delivery_poll" (
	"id" integer PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_poll_one_row" CHECK ("delivery_poll"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "delivery_report" jsonb;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "report_without_recipient" uuid;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "delivery" text;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "delivery_detail" text;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD COLUMN "delivery_source" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_report_without_recipient_message_id_fk" FOREIGN KEY ("report_without_recipient") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_recipient_provider_id_idx" ON "outbox_recipient" USING btree ("provider_id");--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD CONSTRAINT "outbox_recipient_delivery" CHECK ("outbox_recipient"."delivery" is null or "outbox_recipient"."delivery" in ('delivered', 'soft_bounce', 'hard_bounce', 'rejected', 'spam'));--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD CONSTRAINT "outbox_recipient_delivery_at" CHECK (("outbox_recipient"."delivery" is null) = ("outbox_recipient"."delivery_at" is null));--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD CONSTRAINT "outbox_recipient_delivery_source" CHECK ("outbox_recipient"."delivery_source" is null or "outbox_recipient"."delivery_source" in ('webhook', 'activity', 'report'));