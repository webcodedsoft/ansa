// Development seed: registers one tenant against the number the carrier actually calls.
//
// Not a migration. Migrations describe the schema every environment shares; this is one
// row that only makes sense on a developer's line, and the number comes from the
// environment rather than the repository.
//
//   SEED_DIALLED_NUMBER=+1... node packages/db/seeds/dev-tenant.mjs
import { createRequire } from "node:module";

const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");

const dialled = process.env.SEED_DIALLED_NUMBER;
if (dialled === undefined) throw new Error("SEED_DIALLED_NUMBER must be set");

const url = process.env.MIGRATION_DIRECT_URL ?? process.env.MIGRATION_URL;
if (url === undefined) throw new Error("MIGRATION_DIRECT_URL or MIGRATION_URL must be set");

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

// Terms on top of the base list in apps/api/src/tenancy/defaults.ts, not instead of it.
const keyterms = [
  "Kano General",
  "third party",
  "comprehensive",
  "motor cover",
  "fire and special perils",
  "Ikeja",
  "Yaba",
  "Lekki",
  "Adebayo",
  "Chukwu",
  "Olabisi",
];

const { rows } = await client.query(
  `insert into tenants (name, dialled_number, keyterms, persona, config_version)
        values ($1, $2, $3, $4, 1)
   on conflict (dialled_number) where dialled_number is not null
     do update set keyterms = excluded.keyterms,
                   persona  = excluded.persona,
                   config_version = tenants.config_version + 1
     returning id, name, config_version, array_length(keyterms, 1) as keyterms`,
  [
    "Kano General Insurance",
    dialled,
    keyterms,
    "Warm and direct. Nigerian English. Never rush the caller off the line.",
  ],
);

console.log("seeded:", JSON.stringify(rows[0]));
await client.end();
