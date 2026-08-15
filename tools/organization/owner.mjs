// Giving an organisation its first owner. The operator's other half of onboarding.
//
// `provision.mjs` creates the organization and claims its number. This puts a person in it, and
// it is separate for the same reason: `users` has no INSERT grant for `ansa_app` at all,
// because the only supported way a person comes into existence is by redeeming an
// invitation — and the first invitation has nobody to issue it.
//
//   MIGRATION_DIRECT_URL=... node tools/organization/owner.mjs <organization-uuid> <email> [role]
//
// It writes an invitation row and prints the token once. It does **not** create the user
// and does not touch a password: the invited person sets their own through the public
// endpoint, hashed by the same code every other password goes through. An operator who
// never sees a password cannot leak one, and there is no second hashing implementation to
// drift from the first.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${root}packages/db/package.json`);
const { Client } = require("pg");

// The token format lives in one place. Requiring the build rather than re-implementing
// `ansa_inv.<secret>` here is the point: a second implementation is a second thing to get
// wrong, and the way it would fail is a token that never redeems.
const apiRequire = createRequire(`${root}apps/api/package.json`);
let mintInvitationToken;
try {
  ({ mintInvitationToken } = apiRequire("./dist/api/auth/tokens.js"));
} catch {
  throw new Error("run `pnpm --filter @ansa/api build` first: this uses the API's own token format");
}

const fromEnvFile = () => {
  try {
    return Object.fromEntries(
      readFileSync(`${root}.env`, "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
  } catch {
    return {};
  }
};

const env = { ...fromEnvFile(), ...process.env };

const [organizationId, email, role = "owner"] = process.argv.slice(2);
if (!organizationId || !email) {
  throw new Error("usage: owner.mjs <organization-uuid> <email> [owner|admin|member]");
}
if (!["owner", "admin", "member"].includes(role)) {
  throw new Error(`${role} is not a role — use owner, admin or member`);
}

const url = env.MIGRATION_DIRECT_URL ?? env.MIGRATION_URL;
if (!url) throw new Error("MIGRATION_DIRECT_URL must be set: this runs as the owner");

const DAYS = 7;
const expiresAt = new Date(Date.now() + DAYS * 24 * 60 * 60 * 1000);
const minted = mintInvitationToken();

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const { rows: organizations } = await client.query("select id, name from organizations where id = $1", [organizationId]);
if (organizations.length === 0) {
  await client.end();
  throw new Error(`no organization ${organizationId} — run provision.mjs first`);
}

// Supersedes any live invitation for the same address, exactly as the API's own
// re-invite does. Two valid tokens for one seat is a state nobody asked for.
await client.query(
  `update invitations set revoked_at = now()
    where organization_id = $1 and email = $2 and accepted_at is null and revoked_at is null`,
  [organizationId, email.toLowerCase()],
);

await client.query(
  `insert into invitations (organization_id, email, role, token_hash, expires_at)
   values ($1, $2, $3, $4, $5)`,
  [organizationId, email.toLowerCase(), role, minted.hash, expiresAt],
);

await client.end();

console.log(`invited ${email} to ${organizations[0].name} as ${role}, expiring ${expiresAt.toISOString()}\n`);
console.log("give them this token once — it is not recoverable:\n");
console.log(`  ${minted.token}\n`);
console.log("they redeem it with:\n");
console.log("  POST <base-url>/api/v1/invitations/accept");
console.log('  { "token": "<the token>", "password": "<theirs>", "displayName": "<their name>" }');
