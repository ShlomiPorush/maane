CREATE TABLE "outbox" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"mime" "bytea" NOT NULL,
	"message_id_header" text NOT NULL,
	"from_address" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"problem" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_message_id_header_unique" UNIQUE("message_id_header"),
	CONSTRAINT "outbox_state" CHECK ("outbox"."state" in ('pending', 'sending', 'accepted', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "outbox_recipient" (
	"message_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"response" text,
	"marked_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_recipient_message_id_address_pk" PRIMARY KEY("message_id","address"),
	CONSTRAINT "outbox_recipient_kind" CHECK ("outbox_recipient"."kind" in ('to', 'cc')),
	CONSTRAINT "outbox_recipient_state" CHECK ("outbox_recipient"."state" in ('pending', 'accepted', 'refused', 'unknown')),
	CONSTRAINT "outbox_recipient_provider" CHECK ("outbox_recipient"."provider" is null or "outbox_recipient"."provider" in ('smtp2go', 'failover'))
);
--> statement-breakpoint
CREATE TABLE "upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"declared_type" text,
	"size" bigint NOT NULL,
	"content" "bytea",
	"status" text DEFAULT 'scanning' NOT NULL,
	"signature" text,
	"blocked_by" text,
	"stored_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scanned_at" timestamp with time zone,
	CONSTRAINT "upload_status" CHECK ("upload"."status" in ('scanning', 'clean', 'not_fully_scanned', 'not_scanned', 'infected', 'blocked_type', 'too_large', 'scanner_unavailable')),
	CONSTRAINT "upload_content" CHECK (("upload"."content" is null) = ("upload"."status" <> 'scanning')),
	CONSTRAINT "upload_stored" CHECK (("upload"."stored_sha256" is not null) = ("upload"."status" in ('clean', 'not_fully_scanned', 'not_scanned')))
);
--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "source_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "graph_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "folder" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "graph" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "direction" text DEFAULT 'in' NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "author_user_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "submission_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "signature" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD CONSTRAINT "outbox_recipient_message_id_outbox_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."outbox"("message_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_recipient" ADD CONSTRAINT "outbox_recipient_marked_by_auth_user_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_stored_sha256_stored_file_sha256_fk" FOREIGN KEY ("stored_sha256") REFERENCES "public"."stored_file"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_state_idx" ON "outbox" USING btree ("state");--> statement-breakpoint
CREATE INDEX "upload_user_idx" ON "upload" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_author_user_id_auth_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_submission" ON "message" USING btree ("author_user_id","submission_id") WHERE "message"."submission_id" is not null;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_direction" CHECK ("message"."direction" in ('in', 'out', 'note'));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_incoming" CHECK ("message"."direction" <> 'in' or ("message"."source_id" is not null and "message"."graph_id" is not null and "message"."folder" is not null and "message"."graph" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_written" CHECK ("message"."direction" = 'in' or ("message"."author_user_id" is not null and "message"."submission_id" is not null and "message"."ticket_id" is not null and "message"."state" = 'processed'));--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_signature_length" CHECK (char_length("organization"."signature") <= 2000);