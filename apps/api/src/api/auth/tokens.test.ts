import { asTenantId } from "@ansa/shared";
import { describe, expect, it } from "vitest";

import { bearerToken, hashSecret, mintInvitationToken, mintSessionToken, readInvitationToken, readSessionToken } from "./tokens";

const TENANT = asTenantId("11111111-1111-4111-8111-111111111111");
const OTHER = asTenantId("22222222-2222-4222-8222-222222222222");

describe("session tokens", () => {
  it("carry the organisation they belong to", () => {
    const minted = mintSessionToken(TENANT);
    expect(readSessionToken(minted.token)?.claimedTenantId).toBe(TENANT);
  });

  /** Only the digest is stored, so a database dump is not a list of live logins. */
  it("are stored as a digest of a secret that never repeats", () => {
    const a = mintSessionToken(TENANT);
    const b = mintSessionToken(TENANT);
    expect(a.token).not.toBe(b.token);
    expect(a.hash.equals(b.hash)).toBe(false);
    expect(a.hash.length).toBe(32);
    expect(a.token).not.toContain(a.hash.toString("base64"));
  });

  /**
   * The safety of trusting the tenant in the token before verifying it: the secret is
   * hashed independently of the organisation named beside it, so rewriting that part
   * produces a token that opens the wrong scope and finds no session there.
   */
  it("hash the same whichever organisation is claimed, so a rewritten claim finds nothing", () => {
    const minted = mintSessionToken(TENANT);
    const forged = minted.token.replace(TENANT, OTHER);
    const read = readSessionToken(forged);
    expect(read?.claimedTenantId).toBe(OTHER);
    expect(read?.hash.equals(minted.hash)).toBe(true);
  });

  it("reject anything that is not one", () => {
    expect(readSessionToken("")).toBeNull();
    expect(readSessionToken("ansa_s.not-a-uuid.secret")).toBeNull();
    expect(readSessionToken(`ansa_s.${TENANT}.`)).toBeNull();
    expect(readSessionToken(`ansa_x.${TENANT}.secret`)).toBeNull();
    expect(readSessionToken(`ansa_s.${TENANT}`)).toBeNull();
  });
});

describe("invitation tokens", () => {
  it("carry no organisation, because redemption reads it off the row", () => {
    const minted = mintInvitationToken();
    expect(minted.token.split(".")).toHaveLength(2);
    expect(readInvitationToken(minted.token)?.equals(minted.hash)).toBe(true);
  });

  it("are not interchangeable with session tokens", () => {
    expect(readInvitationToken(mintSessionToken(TENANT).token)).toBeNull();
    expect(readSessionToken(mintInvitationToken().token)).toBeNull();
  });
});

describe("reading the Authorization header", () => {
  it("takes a bearer token and nothing else", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("abc")).toBeNull();
  });

  it("hashes a secret the same way every time", () => {
    expect(hashSecret("x").equals(hashSecret("x"))).toBe(true);
    expect(hashSecret("x").equals(hashSecret("y"))).toBe(false);
  });
});
