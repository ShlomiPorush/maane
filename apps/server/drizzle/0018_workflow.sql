CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_name_form" CHECK ("category"."name" = btrim("category"."name") and char_length("category"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "ticket_category" (
	"ticket_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_category_ticket_id_category_id_pk" PRIMARY KEY("ticket_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "ticket" DROP CONSTRAINT "ticket_status";--> statement-breakpoint
ALTER TABLE "ticket_category" ADD CONSTRAINT "ticket_category_ticket_id_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."ticket"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_category" ADD CONSTRAINT "ticket_category_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_name_unique" ON "category" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "ticket_category_category_idx" ON "ticket_category" USING btree ("category_id");--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_status" CHECK ("ticket"."status" in ('new', 'open', 'pending', 'on_hold', 'solved', 'closed'));