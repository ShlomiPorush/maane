-- Custom migration (drizzle-kit generate --custom): the import's one row (plan 5.1), so it always exists and a
-- transaction can lock it. A deployment whose intake mode is already live has gone live: its import window is closed.
INSERT INTO "zendesk_import" ("id", "went_live_at")
SELECT 1, CASE WHEN (SELECT "value" FROM "setting" WHERE "key" = 'intake.mode') = '"live"'::jsonb THEN now() END
ON CONFLICT ("id") DO NOTHING;
