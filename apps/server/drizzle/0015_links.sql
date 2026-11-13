CREATE TABLE "link_click" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"link_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"country" text,
	"city" text,
	"region" text,
	"isp" text,
	"asn" bigint,
	"device" text,
	"os" text,
	"browser" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "tracked_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"message_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text,
	"part_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracked_link_code_unique" UNIQUE("code"),
	CONSTRAINT "tracked_link_kind" CHECK ("tracked_link"."kind" in ('url', 'file')),
	CONSTRAINT "tracked_link_target" CHECK (("tracked_link"."kind" = 'url' and "tracked_link"."url" is not null and "tracked_link"."part_id" is null) or ("tracked_link"."kind" = 'file' and "tracked_link"."part_id" is not null and "tracked_link"."url" is null))
);
--> statement-breakpoint
ALTER TABLE "link_click" ADD CONSTRAINT "link_click_link_id_tracked_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."tracked_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link" ADD CONSTRAINT "tracked_link_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracked_link" ADD CONSTRAINT "tracked_link_part_id_message_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."message_part"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_click_link_idx" ON "link_click" USING btree ("link_id","at");--> statement-breakpoint
CREATE INDEX "tracked_link_message_idx" ON "tracked_link" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "tracked_link_part_idx" ON "tracked_link" USING btree ("part_id");