import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password";

const PASSWORD = "correct horse battery staple";

describe("password hashing", () => {
  it("verifies the password it hashed", async () => {
    expect(await verifyPassword(await hashPassword(PASSWORD), PASSWORD)).toBe(true);
  });

  it("rejects a different password", async () => {
    expect(await verifyPassword(await hashPassword(PASSWORD), `${PASSWORD}!`)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  /** The parameters travel with the hash, which is what makes raising them later safe. */
  it("stores its parameters alongside the digest", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored.split("$").slice(0, 4)).toEqual(["scrypt", "32768", "8", "1"]);
  });

  it("verifies a hash produced at different parameters", async () => {
    // What a hash written before the cost was raised would look like: same encoding, lower N.
    const { scryptSync, randomBytes } = await import("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync(PASSWORD, salt, 64, { N: 1024, r: 8, p: 1 });
    const legacy = ["scrypt", 1024, 8, 1, salt.toString("base64"), key.toString("base64")].join("$");
    expect(await verifyPassword(legacy, PASSWORD)).toBe(true);
  });

  it("refuses a hash it does not recognise rather than throwing", async () => {
    expect(await verifyPassword("bcrypt$whatever", PASSWORD)).toBe(false);
    expect(await verifyPassword("", PASSWORD)).toBe(false);
  });

  /**
   * An address with no account has to cost what a wrong password costs. Without it,
   * response time answers "does this person have an account here" for anyone who asks.
   */
  it("spends real work on an account that does not exist", async () => {
    const start = process.hrtime.bigint();
    expect(await verifyPassword(null, PASSWORD)).toBe(false);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeGreaterThan(10);
  });
});
