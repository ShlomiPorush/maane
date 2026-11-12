-- Custom migration (drizzle-kit generate --custom): the row of the intake mode, so it always exists and a
-- transaction can lock it. Listening is the default: Maane only records until the owner switches to live.
INSERT INTO "setting" ("key", "value", "updated_by") VALUES ('intake.mode', '"listening"'::jsonb, 'system')
ON CONFLICT ("key") DO NOTHING;
