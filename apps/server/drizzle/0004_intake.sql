CREATE SEQUENCE "public"."ticket_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "intake_cursor" (
	"source_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"link" text NOT NULL,
	"kind" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_cursor_source_id_folder_pk" PRIMARY KEY("source_id","folder"),
	CONSTRAINT "intake_cursor_folder" CHECK ("intake_cursor"."folder" in ('inbox', 'junkemail')),
	CONSTRAINT "intake_cursor_kind" CHECK ("intake_cursor"."kind" in ('next', 'delta'))
);
--> statement-breakpoint
CREATE TABLE "intake_record" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"outcome" text NOT NULL,
	"classification" text,
	"support_address" text,
	"organization_id" uuid,
	"ticket_id" uuid,
	"matched_ticket_id" uuid,
	"matched_message_id" uuid,
	"match_layer" text,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_record_mode" CHECK ("intake_record"."mode" in ('listening', 'live')),
	CONSTRAINT "intake_record_outcome" CHECK ("intake_record"."outcome" in ('copy', 'automated', 'unreadable', 'no_address', 'new_ticket', 'joined', 'new_linked_ticket'))
);
--> statement-breakpoint
CREATE TABLE "intake_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"mailbox" text NOT NULL,
	"current" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_source_lower_case" CHECK ("intake_source"."tenant_id" = lower("intake_source"."tenant_id") and "intake_source"."mailbox" = lower("intake_source"."mailbox"))
);
--> statement-breakpoint
CREATE TABLE "message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"graph_id" text NOT NULL,
	"folder" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"state" text DEFAULT 'stored' NOT NULL,
	"content" text NOT NULL,
	"graph" jsonb NOT NULL,
	"size" bigint,
	"message_id_header" text,
	"in_reply_to" text[] DEFAULT '{}'::text[] NOT NULL,
	"references" text[] DEFAULT '{}'::text[] NOT NULL,
	"from_address" text,
	"from_name" text,
	"to_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc_addresses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"subject" text,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text_body" text,
	"html_body" text,
	"content_hash" text,
	"raw_status" text,
	"raw_sha256" text,
	"report_original_message_id" text,
	"review_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"classification" text,
	"automated_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"ticket_id" uuid,
	"duplicate_of" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_state" CHECK ("message"."state" in ('stored', 'processed')),
	CONSTRAINT "message_content" CHECK ("message"."content" in ('parsed', 'unavailable', 'unparsed', 'too_large')),
	CONSTRAINT "message_folder" CHECK ("message"."folder" in ('inbox', 'junkemail'))
);
--> statement-breakpoint
CREATE TABLE "message_part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"kind" text NOT NULL,
	"file_name" text,
	"declared_type" text,
	"content_id" text,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"signature" text,
	"blocked_by" text,
	"stored_sha256" text,
	"unavailable_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_part_kind" CHECK ("message_part"."kind" in ('attachment', 'inline')),
	CONSTRAINT "message_part_status" CHECK ("message_part"."status" in ('clean', 'infected', 'not_fully_scanned', 'blocked_type', 'waiting', 'not_scanned', 'unavailable', 'too_large')),
	CONSTRAINT "message_part_stored" CHECK ("message_part"."stored_sha256" is null or "message_part"."status" in ('clean', 'not_fully_scanned', 'not_scanned'))
);
--> statement-breakpoint
CREATE TABLE "ticket" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint DEFAULT nextval('ticket_number_seq') NOT NULL,
	"reference_code" text NOT NULL,
	"organization_id" uuid NOT NULL,
	"support_address" text NOT NULL,
	"subject" text,
	"status" text DEFAULT 'new' NOT NULL,
	"review_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_number_unique" UNIQUE("number"),
	CONSTRAINT "ticket_reference_code_unique" UNIQUE("reference_code"),
	CONSTRAINT "ticket_status" CHECK ("ticket"."status" in ('new', 'open')),
	CONSTRAINT "ticket_reference_code" CHECK ("ticket"."reference_code" ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$')
);
--> statement-breakpoint
CREATE TABLE "ticket_link" (
	"ticket_id" uuid NOT NULL,
	"linked_ticket_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_link_ticket_id_linked_ticket_id_pk" PRIMARY KEY("ticket_id","linked_ticket_id")
);
--> statement-breakpoint
CREATE TABLE "ticket_participant" (
	"ticket_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_participant_ticket_id_address_pk" PRIMARY KEY("ticket_id","address")
);
--> statement-breakpoint
CREATE TABLE "ticket_pending_reference" (
	"ticket_id" uuid NOT NULL,
	"message_id_header" text NOT NULL,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_pending_reference_ticket_id_message_id_header_pk" PRIMARY KEY("ticket_id","message_id_header")
);
--> statement-breakpoint
ALTER TABLE "intake_cursor" ADD CONSTRAINT "intake_cursor_source_id_intake_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intake_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_matched_ticket_id_ticket_id_fk" FOREIGN KEY ("matched_ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_matched_message_id_message_id_fk" FOREIGN KEY ("matched_message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_source_id_intake_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."intake_source"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_raw_sha256_stored_file_sha256_fk" FOREIGN KEY ("raw_sha256") REFERENCES "public"."stored_file"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_part" ADD CONSTRAINT "message_part_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_part" ADD CONSTRAINT "message_part_stored_sha256_stored_file_sha256_fk" FOREIGN KEY ("stored_sha256") REFERENCES "public"."stored_file"("sha256") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_link" ADD CONSTRAINT "ticket_link_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_link" ADD CONSTRAINT "ticket_link_linked_ticket_id_ticket_id_fk" FOREIGN KEY ("linked_ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_participant" ADD CONSTRAINT "ticket_participant_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_pending_reference" ADD CONSTRAINT "ticket_pending_reference_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_pending_reference" ADD CONSTRAINT "ticket_pending_reference_resolved_by_message_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_record_created_idx" ON "intake_record" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_source_pair" ON "intake_source" USING btree ("tenant_id","mailbox");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_source_one_current" ON "intake_source" USING btree ((true)) WHERE "intake_source"."current";--> statement-breakpoint
CREATE UNIQUE INDEX "message_source_graph" ON "message" USING btree ("source_id","graph_id");--> statement-breakpoint
CREATE INDEX "message_state_received_idx" ON "message" USING btree ("state","received_at");--> statement-breakpoint
CREATE INDEX "message_message_id_idx" ON "message" USING btree ("message_id_header");--> statement-breakpoint
CREATE INDEX "message_ticket_idx" ON "message" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_part_position" ON "message_part" USING btree ("message_id","index");--> statement-breakpoint
CREATE INDEX "message_part_status_idx" ON "message_part" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ticket_organization_idx" ON "ticket" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "ticket_link_linked_idx" ON "ticket_link" USING btree ("linked_ticket_id");--> statement-breakpoint
CREATE INDEX "ticket_pending_reference_message_id_idx" ON "ticket_pending_reference" USING btree ("message_id_header");