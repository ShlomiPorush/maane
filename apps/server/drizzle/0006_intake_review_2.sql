ALTER TABLE "message" ADD COLUMN "would_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "possibly_automated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_would_ticket_id_ticket_id_fk" FOREIGN KEY ("would_ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;