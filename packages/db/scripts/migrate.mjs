#!/usr/bin/env node
/**
 * Apply the migrations this database has not seen.
 *
 * Written because "apply all pending migrations" was, until now, a question nothing could
 * answer. Migrations are raw SQL applied by hand with psql and nothing recorded which had
 * run, so the only way to establish the state of a database was to read all fifty files, work
 * out what each one creates, and check the catalogue for it one object at a time. That is
 * slow, it is a judgement call rather than a fact, and it is how a migration gets applied
 * twice or skipped entirely.
 *
 * Not idempotency instead of a ledger, which is the tempting shortcut. Most of these files
 * are written to be re-runnable — `create or replace function`, `add column if not exists` —
 * but not all of them can be: 0048 renames a constraint, and a second run fails because the
 * old name is gone. A ledger is the only thing that makes "run everything" safe, and once
 * there is a ledger the idempotency is a nicety rather than the mechanism.
 *
 * Two modes:
 *
 *   (default)     apply every file not in the ledger, in filename order, each in its own
 *                 transaction, recording it as it goes.
 *   --baseline    record every file as applied without running any of it. For a database that
 *                 was migrated by hand before this existed — which is every database today.
 *                 Refuses to run if the ledger already has rows.
 *
 * Connects with MIGRATION_DIRECT_URL: the owner, on the direct port. `ansa_app` cannot ALTER,
 * and the pooler is the wrong place for DDL.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, "..", "migrations");

/** Only what the repo tracks, in the order the filenames impose. */
const migrationFiles = () =>
  readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql"))
    .sort();

const checksumOf = (filename) =>
  createHash("sha256").update(readFileSync(join(MIGRATIONS, filename))).digest("hex");

/**
 * The ledger, in `app` beside everything else that is ours rather than in `public` beside the
 * tables. Owner-only: nothing grants it to `ansa_app`, because a role that cannot ALTER has
 * no business reading which ALTERs have run.
 */
const LEDGER = `
  create table if not exists app.schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )
`;

const main = async () => {
  const baseline = process.argv.includes("--baseline");
  const url = process.env["MIGRATION_DIRECT_URL"];
  if (url === undefined || url === "") {
    console.error("MIGRATION_DIRECT_URL is not set. It must be the owner, on the direct port.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query("create schema if not exists app");
    await client.query(LEDGER);

    const recorded = new Map(
      (await client.query("select filename, checksum from app.schema_migrations")).rows.map(
        (row) => [row.filename, row.checksum],
      ),
    );
    const files = migrationFiles();

    if (baseline) {
      if (recorded.size > 0) {
        console.error(
          `refusing to baseline: the ledger already has ${recorded.size} rows. ` +
            "Baselining is for a database migrated by hand before the ledger existed.",
        );
        process.exit(1);
      }
      for (const filename of files) {
        await client.query(
          "insert into app.schema_migrations (filename, checksum) values ($1, $2)",
          [filename, checksumOf(filename)],
        );
      }
      console.log(`baselined ${files.length} migrations as already applied. Nothing was run.`);
      return;
    }

    /* A file that changed after it was applied is the failure this catches, and it is worth
       stopping for rather than warning about. Editing an applied migration means this
       database and a fresh one built from the same repo no longer agree, and every later
       migration was written against whichever version happened to run. */
    const drifted = files.filter(
      (filename) => recorded.has(filename) && recorded.get(filename) !== checksumOf(filename),
    );
    if (drifted.length > 0) {
      console.error("these migrations were edited after being applied:");
      for (const filename of drifted) console.error(`  ${filename}`);
      console.error("Write a new migration instead. Nothing was run.");
      process.exit(1);
    }

    const pending = files.filter((filename) => !recorded.has(filename));
    if (pending.length === 0) {
      console.log(`nothing pending: ${files.length} migrations already applied.`);
      return;
    }

    for (const filename of pending) {
      const sql = readFileSync(join(MIGRATIONS, filename), "utf8");
      /* One transaction per file rather than one for all of them. A failure halfway through a
         run leaves the earlier files applied and recorded, so re-running continues from the
         one that broke instead of replaying work that succeeded. */
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into app.schema_migrations (filename, checksum) values ($1, $2)",
          [filename, checksumOf(filename)],
        );
        await client.query("commit");
        console.log(`applied ${filename}`);
      } catch (error) {
        await client.query("rollback");
        console.error(`failed on ${filename}: ${error instanceof Error ? error.message : error}`);
        console.error("Rolled back. Earlier files in this run stay applied and recorded.");
        process.exit(1);
      }
    }
    console.log(`applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
};

await main();
