CREATE INDEX "message_text_trgm_idx" ON "message" USING gin ("text_body" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ticket_subject_trgm_idx" ON "ticket" USING gin ("subject" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ticket_participant_address_trgm_idx" ON "ticket_participant" USING gin ("address" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "ticket_participant_name_trgm_idx" ON "ticket_participant" USING gin ("name" gin_trgm_ops);