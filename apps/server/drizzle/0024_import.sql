CREATE TABLE "import_report" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"zendesk_id" bigint NOT NULL,
	"reason" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "import_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"reason" text,
	"problems" jsonb,
	"started_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"archive_origin" text,
	"archive_runs" integer,
	"covered_until" timestamp with time zone,
	"highest_number" bigint,
	"position" bigint,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "import_run_state" CHECK ("import_run"."state" in ('running', 'done', 'stopped', 'refused'))
);
--> statement-breakpoint
CREATE TABLE "zendesk_brand_map" (
	"brand_id" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zendesk_import" (
	"id" integer PRIMARY KEY NOT NULL,
	"went_live_at" timestamp with time zone,
	"origin" text,
	"agent_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "zendesk_import_one_row" CHECK ("zendesk_import"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "zendesk_tag_map" (
	"tag" text PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_incoming";--> statement-breakpoint
ALTER TABLE "message" DROP CONSTRAINT "message_written";--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "zendesk_key" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "zendesk" jsonb;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "zendesk_id" bigint;--> statement-breakpoint
ALTER TABLE "ticket" ADD COLUMN "zendesk" jsonb;--> statement-breakpoint
ALTER TABLE "import_report" ADD CONSTRAINT "import_report_run_id_import_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."import_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_run" ADD CONSTRAINT "import_run_started_by_auth_user_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zendesk_brand_map" ADD CONSTRAINT "zendesk_brand_map_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zendesk_import" ADD CONSTRAINT "zendesk_import_agent_user_id_auth_user_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."auth_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zendesk_tag_map" ADD CONSTRAINT "zendesk_tag_map_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_report_run_idx" ON "import_report" USING btree ("run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "import_run_one_running" ON "import_run" USING btree ((true)) WHERE "import_run"."state" = 'running';--> statement-breakpoint
CREATE INDEX "import_run_created_idx" ON "import_run" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_zendesk_key_unique" UNIQUE("zendesk_key");--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_zendesk_id_unique" UNIQUE("zendesk_id");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_zendesk" CHECK (("message"."zendesk_key" is null) = ("message"."zendesk" is null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_imported" CHECK ("message"."zendesk_key" is null or ("message"."ticket_id" is not null and "message"."state" = 'processed' and "message"."submission_id" is null and ("message"."direction" = 'in') = ("message"."author_user_id" is null)));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_incoming" CHECK ("message"."direction" <> 'in' or "message"."zendesk_key" is not null or ("message"."source_id" is not null and "message"."graph_id" is not null and "message"."folder" is not null and "message"."graph" is not null));--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_written" CHECK ("message"."direction" = 'in' or "message"."zendesk_key" is not null or (("message"."author_user_id" is not null or "message"."direction" = 'out') and "message"."submission_id" is not null and "message"."ticket_id" is not null and "message"."state" = 'processed'));--> statement-breakpoint
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_zendesk" CHECK (("ticket"."zendesk_id" is null) = ("ticket"."zendesk" is null));