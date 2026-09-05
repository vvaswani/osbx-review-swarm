-- Migration: add `publisher` column to the `books` table.
--
-- Fresh databases get the column from db.sql (CREATE TABLE ... publisher
-- VARCHAR(255) NOT NULL). This file provides the safe upgrade path for
-- EXISTING databases:
--
--   psql "$DATABASE_URL" -f migrations/001_add_publisher.sql
--
-- A naive `ALTER TABLE books ADD COLUMN publisher VARCHAR(255) NOT NULL;`
-- would fail on populated tables (no default and existing NULL rows), so we:
--   1. add the column as nullable,
--   2. backfill existing rows with an empty placeholder,
--   3. apply the NOT NULL constraint to match the application model.
ALTER TABLE books ADD COLUMN IF NOT EXISTS publisher VARCHAR(255);

UPDATE books SET publisher = '' WHERE publisher IS NULL;

ALTER TABLE books ALTER COLUMN publisher SET NOT NULL;