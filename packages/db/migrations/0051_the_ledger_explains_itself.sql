-- What `app.schema_migrations` is, written where somebody reading the schema will find it.
--
-- The table is created by `scripts/migrate.mjs` rather than by a migration, which is the
-- ordinary bootstrapping problem — a ledger cannot record the migration that creates it. The
-- cost of that is a table appearing in the catalogue with no file explaining it, and the next
-- person finding it has to go and read the runner to learn whether it is safe to touch.
--
-- This file is also the first thing the runner has ever applied. Every migration before it
-- went in by hand with psql, so the apply path had never executed once — and a runner nobody
-- has run is not tooling, it is a plan. Making its first job a change that cannot break
-- anything is the cheapest way to find out whether it works.

comment on table app.schema_migrations is
  'Which migration files have been applied to this database, and the sha256 of each as it '
  'was when it ran. Created by packages/db/scripts/migrate.mjs, not by a migration — a '
  'ledger cannot record its own creation. Owner-only: ansa_app cannot ALTER, so it has no '
  'reason to read which ALTERs have happened. A checksum that no longer matches the file '
  'means an applied migration was edited, which the runner refuses to continue past: this '
  'database and a fresh one built from the same repo have stopped agreeing.';
