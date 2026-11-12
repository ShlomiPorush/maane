CREATE TABLE "intake_conversation_ticket_link" (
	"conversation_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_conversation_ticket_link_conversation_id_ticket_id_pk" PRIMARY KEY("conversation_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "intake_ticket_pending" (
	"ticket_id" uuid NOT NULL,
	"message_id_header" text NOT NULL,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_ticket_pending_ticket_id_message_id_header_pk" PRIMARY KEY("ticket_id","message_id_header")
);
--> statement-breakpoint
ALTER TABLE "intake_conversation_ticket_link" ADD CONSTRAINT "intake_conversation_ticket_link_conversation_id_intake_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."intake_conversation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_conversation_ticket_link" ADD CONSTRAINT "intake_conversation_ticket_link_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_ticket_pending" ADD CONSTRAINT "intake_ticket_pending_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_ticket_pending" ADD CONSTRAINT "intake_ticket_pending_resolved_by_message_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intake_ticket_pending_message_id_idx" ON "intake_ticket_pending" USING btree ("message_id_header");