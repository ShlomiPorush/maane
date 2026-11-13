-- Plan 3.4, review L1: the first delivery time 0016 added, filled for recipients a delivered event reached before this
-- version. Only a recipient whose current status is still `delivered` shows it; one a later event (a spam report, a bounce)
-- replaced keeps it empty, and its clicks are measured from its acceptance, as before.
UPDATE "outbox_recipient" SET "first_delivered_at" = "delivery_at"
WHERE "first_delivered_at" IS NULL AND "delivery" = 'delivered' AND "delivery_at" IS NOT NULL;
