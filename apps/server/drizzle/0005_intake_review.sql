CREATE TABLE "intake_conversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"support_address" text NOT NULL,
	"review_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intake_conversation_link" (
	"conversation_id" uuid NOT NULL,
	"linked_conversation_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_conversation_link_conversation_id_linked_conversation_id_pk" PRIMARY KEY("conversation_id","linked_conversation_id")
);
--> statement-breakpoint
CREATE TABLE "intake_conversation_participant" (
	"conversation_id" uuid NOT NULL,
	"address" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_conversation_participant_conversation_id_address_pk" PRIMARY KEY("conversation_id","address")
);
--> statement-breakpoint
CREATE TABLE "intake_conversation_pending" (
	"conversation_id" uuid NOT NULL,
	"message_id_header" text NOT NULL,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_conversation_pending_conversation_id_message_id_header_pk" PRIMARY KEY("conversation_id","message_id_header")
);
--> statement-breakpoint
ALTER TABLE "intake_record" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "intake_record" ADD COLUMN "matched_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "content_type" jsonb;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "field_scans" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "process_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "retry_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intake_conversation" ADD CONSTRAINT "intake_conversation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_link" ADD CONSTRAINT "intake_conversation_link_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_link" ADD CONSTRAINT "intake_conversation_link_linked_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("linked_conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_participant" ADD CONSTRAINT "intake_conversation_participant_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_pending" ADD CONSTRAINT "intake_conversation_pending_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_pending" ADD CONSTRAINT "intake_conversation_pending_resolved_by_message_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_conversation_organization_idx" ON "intake_conversation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "intake_conversation_pending_message_id_idx" ON "intake_conversation_pending" USING btree ("message_id_header");--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_record" ADD CONSTRAINT "intake_record_matched_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("matched_conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;