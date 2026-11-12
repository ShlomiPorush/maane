CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_name_form" CHECK ("organization"."name" = btrim("organization"."name") and char_length("organization"."name") between 1 and 80)
);
--> statement-breakpoint
CREATE TABLE "organization_member" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "support_address" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_address_value_unique" UNIQUE("value"),
	CONSTRAINT "support_address_kind" CHECK ("support_address"."kind" in ('exact', 'pattern')),
	CONSTRAINT "support_address_lower_case" CHECK ("support_address"."value" = lower("support_address"."value")),
	CONSTRAINT "support_address_default_exact" CHECK (not "support_address"."is_default" or "support_address"."kind" = 'exact')
);
--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_user_id_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_address" ADD CONSTRAINT "support_address_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_name_unique" ON "organization" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "organization_member_user_idx" ON "organization_member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_address_organization_idx" ON "support_address" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_address_one_default" ON "support_address" USING btree ((true)) WHERE "support_address"."is_default";