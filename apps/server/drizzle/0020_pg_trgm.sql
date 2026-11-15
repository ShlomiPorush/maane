-- Search (plan 4.4): pg_trgm, PostgreSQL's trigram module, whose GIN operator class serves ILIKE '%term%'. A trusted
-- extension: the database owner may create it. The indexes come in the next migration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
