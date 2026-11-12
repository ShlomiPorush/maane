CREATE TABLE "scanner_check" (
	"id" integer PRIMARY KEY NOT NULL,
	"address" text NOT NULL,
	"ok" boolean NOT NULL,
	"failed_check" text,
	"version" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "scanner_check_one_row" CHECK ("scanner_check"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "stored_file" (
	"sha256" text PRIMARY KEY NOT NULL,
	"size" bigint NOT NULL,
	"detected_type" text NOT NULL,
	"scan_status" text NOT NULL,
	"signature" text,
	"scanned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stored_file_sha256" CHECK ("stored_file"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "stored_file_size" CHECK ("stored_file"."size" >= 0),
	CONSTRAINT "stored_file_status" CHECK ("stored_file"."scan_status" in ('clean', 'not_fully_scanned', 'not_scanned'))
);
