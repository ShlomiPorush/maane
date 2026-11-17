ALTER TABLE "intake_record" DROP CONSTRAINT "intake_record_mode";--> statement-breakpoint
ALTER TABLE "intake_record" DROP CONSTRAINT "intake_record_conversation_id_intake_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "intake_record" DROP CONSTRAINT "intake_record_matched_conversation_id_intake_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_conversation_id_intake_conversation_id_fk";
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_would_ticket_id_ticket_id_fk";
--> statement-breakpoint
ALTER TABLE "intake_record" DROP COLUMN "mode";--> statement-breakpoint
ALTER TABLE "intake_record" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "intake_record" DROP COLUMN "matched_conversation_id";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "conversation_id";--> statement-breakpoint
ALTER TABLE "message" DROP COLUMN "would_ticket_id";--> statement-breakpoint
ALTER TABLE "zendesk_import" DROP COLUMN "went_live_at";