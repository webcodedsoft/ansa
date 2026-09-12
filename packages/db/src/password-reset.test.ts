import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { beginPasswordReset, credentialsForEmail, redeemPasswordReset } from "./accounts";
import { createDataSource, type Db } from "./data-source";
import { loadDotEnv } from "./test-env";

loadDotEnv();

/**
 * Forgetting a password and getting back in (migration 0088).
 *
 * Both functions run unauthenticated, on the unscoped connection, as `ansa_app` — the role
 * that has no access to `password_resets` at all. What they refuse matters more than what
 * they allow: an unknown address must look like a known one, a wrong link must look like
 * an expired one, and a link must work exactly once. And the moment the password changes,
 * every session the person held must stop working.
 */

const appUrl = process.env["DATABASE_URL"];
const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
if (appUrl === undefined) {
  throw new Error("DATABASE_URL must be set: this test needs a database");
}

/** Unique to this file — see the note in `caller-history.test.ts` on why that matters. */
const ORG = "d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8";
const USER = "d9d9d9d9-d9d9-4d9d-8d9d-d9d9d9d9d9d9";
const EMAIL = "reset-d8d8@invalid.test";
const OLD_HASH = "scrypt$old";
const NEW_HASH = "scrypt$new";

const hash = (secret: string): Buffer => createHash("sha256").update(secret).digest();
const inAnHour = (): Date => new Date(Date.now() + 60 * 60 * 1000);

let app: Db;
let owner: Db | null = null;

const liveSessions = async (): Promise<number> => {
  const rows = (await owner?.query(
    "select count(*)::int as n from sessions where user_id = $1 and revoked_at is null",
    [USER],
  )) as { n: number }[];
  return rows[0]?.n ?? -1;
};

describe.skipIf(ownerUrl === undefined)("resetting a forgotten password", () => {
  beforeAll(async () => {
    app = await createDataSource({ url: appUrl, poolSize: 2 }).initialize();
    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();

    await owner.query("insert into organizations (id, name) values ($1, $2)", [ORG, "Reset Test"]);
    await owner.query(
      "insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)",
      [USER, EMAIL, OLD_HASH, "Reset Tester"],
    );
    // Two live sessions, so revocation is visibly "all of them" and not "the first one".
    for (const secret of ["session-one-d8d8", "session-two-d8d8"]) {
      await owner.query(
        "insert into sessions (organization_id, user_id, token_hash, expires_at) values ($1, $2, $3, now() + interval '1 day')",
        [ORG, USER, hash(secret)],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await owner?.query("delete from sessions where user_id = $1", [USER]);
    await owner?.query("delete from password_resets where user_id = $1", [USER]);
    await owner?.query("delete from users where id = $1", [USER]);
    await owner?.query("delete from organizations where id = $1", [ORG]);
    await app?.destroy();
    await owner?.destroy();
  });

  it("keeps the table out of the application role's reach", async () => {
    await expect(app.query("select count(*) from password_resets")).rejects.toThrow(/permission denied/);
  });

  it("answers nothing for an address with no account", async () => {
    expect(await beginPasswordReset(app, "nobody-d8d8@invalid.test", hash("nobody"), inAnHour())).toBeNull();
  });

  it("starts a reset for a known address, whatever the case of the letters", async () => {
    const begun = await beginPasswordReset(app, EMAIL.toUpperCase(), hash("first-link"), inAnHour());
    expect(begun).toEqual({ userId: USER, displayName: "Reset Tester" });
  });

  it("refuses a link that was never issued, without touching the password", async () => {
    expect(await redeemPasswordReset(app, hash("guessed"), NEW_HASH, new Date())).toBeNull();
    expect((await credentialsForEmail(app, EMAIL))?.passwordHash).toBe(OLD_HASH);
  });

  it("retires the earlier link when a newer one is asked for", async () => {
    await beginPasswordReset(app, EMAIL, hash("second-link"), inAnHour());
    expect(await redeemPasswordReset(app, hash("first-link"), NEW_HASH, new Date())).toBeNull();
    expect((await credentialsForEmail(app, EMAIL))?.passwordHash).toBe(OLD_HASH);
  });

  it("refuses a link past its hour", async () => {
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await redeemPasswordReset(app, hash("second-link"), NEW_HASH, later)).toBeNull();
    expect((await credentialsForEmail(app, EMAIL))?.passwordHash).toBe(OLD_HASH);
  });

  it("sets the password from a live link and signs the person out everywhere", async () => {
    expect(await liveSessions()).toBe(2);
    expect(await redeemPasswordReset(app, hash("second-link"), NEW_HASH, new Date())).toBe(USER);
    expect((await credentialsForEmail(app, EMAIL))?.passwordHash).toBe(NEW_HASH);
    expect(await liveSessions()).toBe(0);
  });

  it("works exactly once", async () => {
    expect(await redeemPasswordReset(app, hash("second-link"), "scrypt$third", new Date())).toBeNull();
    expect((await credentialsForEmail(app, EMAIL))?.passwordHash).toBe(NEW_HASH);
  });
});
