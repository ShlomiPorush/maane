ALTER TABLE "message" ADD COLUMN "zendesk_message_id" text;--> statement-breakpoint
ALTER TABLE "zendesk_import" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
-- Comments imported before this migration get their Message-ID from their `zendesk` JSON, which holds the value the
-- source recorded, read as messageIds() in apps/worker/src/intake/parse.ts reads it when a run writes the column: the
-- first `<...>` that holds no `<`, `>`, or whitespace, else the whole value trimmed when it holds no whitespace, and
-- no change of case. Whitespace is JavaScript's (`\s` and trim(), the same set), spelled out by code point because
-- PostgreSQL's classes depend on the locale. The import keeps at most 998 characters of a Message-ID (map.ts), so
-- messageIds()'s length limit drops nothing here.
UPDATE "message" AS "m" SET "zendesk_message_id" = CASE
    WHEN "s"."value" ~ '<[^<>\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+>'
      THEN (regexp_match("s"."value", '<([^<>\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+)>'))[1]
    WHEN "s"."trimmed" <> '' AND "s"."trimmed" !~ '[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]'
      THEN "s"."trimmed"
  END
FROM (
  SELECT "id", "zendesk"->'email'->>'messageId' AS "value",
    regexp_replace(
      "zendesk"->'email'->>'messageId',
      '^[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+|[\t\n\v\f\r\x20\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]+$',
      '', 'g'
    ) AS "trimmed"
  FROM "message"
  WHERE "zendesk_key" IS NOT NULL AND "zendesk"->'email'->>'kind' = 'recorded'
    AND jsonb_typeof("zendesk"->'email'->'messageId') = 'string'
) AS "s"
WHERE "m"."id" = "s"."id";--> statement-breakpoint
CREATE INDEX "message_zendesk_message_id_idx" ON "message" USING hash ("zendesk_message_id");