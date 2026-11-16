-- Custom migration (drizzle-kit generate --custom): the import's one row (plan 5.1), so it always exists and a
-- transaction can lock it. A deployment that has gone live has its import window closed: its intake mode is live now,
-- or its database shows live use from before, when it was switched back to listening since (an audited switch of the
-- intake mode to live, a ticket Maane opened, an outbox row, or a message intake processed in live mode). Every ticket
-- here was opened by Maane: none is imported yet.
INSERT INTO "zendesk_import" ("id", "went_live_at")
SELECT 1, CASE WHEN (SELECT "value" FROM "setting" WHERE "key" = 'intake.mode') = '"live"'::jsonb
  OR EXISTS (SELECT 1 FROM "audit_log" WHERE "action" = 'setting.update' AND "entity_id" = 'intake.mode'
    AND "details"->>'value' = 'live')
  OR EXISTS (SELECT 1 FROM "ticket" WHERE "zendesk_id" IS NULL)
  OR EXISTS (SELECT 1 FROM "outbox")
  OR EXISTS (SELECT 1 FROM "intake_record" WHERE "mode" = 'live')
  THEN now() END
ON CONFLICT ("id") DO NOTHING;
