CREATE TABLE "scheduled_reply" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"set_pending" boolean NOT NULL,
	"editor_html" text NOT NULL,
	"from_address" text NOT NULL,
	"to_addresses" jsonb NOT NULL,
	"cc_addresses" jsonb NOT NULL,
	"html_body" text NOT NULL,
	"text_body" text NOT NULL,
	"files" jsonb NOT NULL,
	"mime" "bytea" NOT NULL,
	"message_id_header" text NOT NULL,
	"subject" text NOT NULL,
	"in_reply_to" text,
	"references" text[] NOT NULL,
	"links" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timed_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" text,
	"submission_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'scheduled' NOT NULL,
	"reason" text,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "timed_action_kind" CHECK ("timed_action"."kind" in ('reply')),
	CONSTRAINT "timed_action_state" CHECK ("timed_action"."state" in ('scheduled', 'handed', 'done', 'cancelled', 'ended'))
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "action_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "action_version" integer;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "snoozed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "snooze_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_reply" ADD CONSTRAINT "scheduled_reply_action_id_timed_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."timed_action"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timed_action" ADD CONSTRAINT "timed_action_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timed_action" ADD CONSTRAINT "timed_action_author_user_id_auth_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timed_action_ticket_idx" ON "timed_action" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "timed_action_submission_unique" ON "timed_action" USING btree ("author_user_id","submission_id");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_action_id_timed_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."timed_action"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_action_version_unique" ON "outbox" USING btree ("action_id","action_version");--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_action" CHECK (("outbox"."action_id" is null) = ("outbox"."action_version" is null));