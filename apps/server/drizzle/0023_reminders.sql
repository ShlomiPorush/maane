CREATE TABLE "reminder" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"period_id" uuid NOT NULL,
	CONSTRAINT "reminder_period_id_unique" UNIQUE("period_id")
);
--> statement-breakpoint
CREATE TABLE "waiting_period" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"message_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	CONSTRAINT "waiting_period_origin" CHECK ("waiting_period"."origin" in ('maane', 'import')),
	CONSTRAINT "waiting_period_end" CHECK (("waiting_period"."ended_at" is null) = ("waiting_period"."end_reason" is null)),
	CONSTRAINT "waiting_period_end_reason" CHECK ("waiting_period"."end_reason" is null or "waiting_period"."end_reason" in ('customer_reply', 'status_change', 'agent_reply', 'move', 'delivery_failed'))
);
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_written";--> statement-breakpoint
ALTER TABLE "timed_action" DROP CONSTRAINT "timed_action_kind";--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "reminder_template" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "reminder_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_action_id_timed_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."timed_action"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder" ADD CONSTRAINT "reminder_period_id_waiting_period_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."waiting_period"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_period" ADD CONSTRAINT "waiting_period_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waiting_period" ADD CONSTRAINT "waiting_period_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waiting_period_open_unique" ON "waiting_period" USING btree ("ticket_id") WHERE "waiting_period"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "waiting_period_message_idx" ON "waiting_period" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_written" CHECK ("message"."direction" = 'in' or (("message"."author_user_id" is not null or "message"."direction" = 'out') and "message"."submission_id" is not null and "message"."ticket_id" is not null and "message"."state" = 'processed'));--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_reminder_template_length" CHECK (char_length("organization"."reminder_template") <= 2000);--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_reminder_days" CHECK ("organization"."reminder_days" between 1 and 60);--> statement-breakpoint
ALTER TABLE "timed_action" ADD CONSTRAINT "timed_action_kind" CHECK ("timed_action"."kind" in ('reply', 'reminder'));