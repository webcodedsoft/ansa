import { describe, expect, it } from "vitest";

import { createEgressGuard, isBlockedAddress, type AddressResolver, type ResolvedAddress } from "./egress";

/**
 * R5.2.2. The tenant supplies the URL, so this suite is the adversary.
 *
 * Table-driven throughout: a guard that only rejects the one address somebody thought of
 * is not a guard, and a table is what makes a change that helps a single literal fail
 * visibly.
 */

const resolverFor = (map: Readonly<Record<string, readonly ResolvedAddress[]>>): AddressResolver => {
  return async (host) => {
    const found = map[host];
    if (found === undefined) throw new Error(`ENOTFOUND ${host}`);
    return found;
  };
};

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

describe("blocked addresses", () => {
  const blocked: readonly [string, string][] = [
    ["0.0.0.0", "this network"],
    ["10.1.2.3", "RFC1918"],
    ["172.16.0.1", "RFC1918 low"],
    ["172.31.255.254", "RFC1918 high"],
    ["192.168.5.5", "RFC1918"],
    ["127.0.0.1", "loopback"],
    ["127.1.1.1", "loopback, whole /8"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.170.2", "container credentials"],
    ["100.100.100.200", "carrier NAT range"],
    ["100.64.0.1", "carrier NAT"],
    ["192.0.0.192", "IETF assignments"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fd00::1", "unique local"],
    ["fc00::1", "unique local"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:169.254.169.254", "v4-mapped metadata"],
    ["::ffff:a9fe:a9fe", "v4-mapped metadata, hex form"],
    ["::ffff:127.0.0.1", "v4-mapped loopback"],
    ["::ffff:10.0.0.1", "v4-mapped RFC1918"],
    ["64:ff9b::169.254.169.254", "NAT64 metadata"],
    ["64:ff9b::a9fe:a9fe", "NAT64 metadata, hex form"],
    ["2002:a9fe:a9fe::1", "6to4 metadata"],
    ["2002:7f00:1::", "6to4 loopback"],
    ["not-an-address", "unparseable fails closed"],
    ["", "empty fails closed"],
  ];

  for (const [address, why] of blocked) {
    it(`blocks ${address} (${why})`, () => {
      expect(isBlockedAddress(address)).toBe(true);
    });
  }

  const allowed: readonly string[] = [
    "8.8.8.8",
    "1.1.1.1",
    "13.107.42.14",
    "196.216.2.1",
    "102.132.96.1",
    "2606:4700:4700::1111",
    "2a03:2880:f10c::1",
    "::ffff:8.8.8.8",
  ];

  for (const address of allowed) {
    it(`allows the public address ${address}`, () => {
      expect(isBlockedAddress(address)).toBe(false);
    });
  }
});

describe("the guard", () => {
  const policy = { allowedHosts: ["api.partner.test", "*.shard.partner.test"] };

  it("refuses a host the tenant never declared, before resolving anything", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: () => {
        throw new Error("must not resolve a host that is not allowlisted");
      },
    });
    const verdict = await guard.check("https://evil.test/records");
    expect(verdict).toMatchObject({ ok: false, reason: "host-not-allowed" });
  });

  it("refuses plaintext http unless the tenant asked for it", async () => {
    const resolve = resolverFor({ "api.partner.test": [v4("8.8.8.8")] });
    const strict = createEgressGuard({ policy, resolve });
    expect(await strict.check("http://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "scheme-not-allowed",
    });

    const permissive = createEgressGuard({ policy: { ...policy, allowPlaintextHttp: true }, resolve });
    expect(await permissive.check("http://api.partner.test/x")).toMatchObject({ ok: true });
  });

  for (const scheme of ["file:///etc/passwd", "gopher://api.partner.test/", "ftp://api.partner.test/"]) {
    it(`refuses the scheme in ${scheme}`, async () => {
      const guard = createEgressGuard({ policy, resolve: resolverFor({}) });
      expect(await guard.check(scheme)).toMatchObject({ ok: false, reason: "scheme-not-allowed" });
    });
  }

  it("refuses credentials smuggled into the authority", async () => {
    const guard = createEgressGuard({ policy, resolve: resolverFor({}) });
    // The host here is 169.254.169.254; everything before the @ is userinfo.
    const verdict = await guard.check("https://api.partner.test@169.254.169.254/latest/meta-data");
    expect(verdict).toMatchObject({ ok: false });
    if (verdict.ok) throw new Error("unreachable");
    expect(["credentials-in-url", "host-not-allowed"]).toContain(verdict.reason);
  });

  it("refuses an allowlisted host that resolves somewhere private", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({ "api.partner.test": [v4("169.254.169.254")] }),
    });
    expect(await guard.check("https://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "blocked-address",
    });
  });

  it("refuses when only one of several answers is private", async () => {
    // The rebinding setup: one good answer to pass a check that looks at the first, one
    // bad answer for the connection to actually use.
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({ "api.partner.test": [v4("8.8.8.8"), v4("127.0.0.1")] }),
    });
    expect(await guard.check("https://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "blocked-address",
    });
  });

  it("refuses a private IPv6 answer for an allowlisted host", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({ "api.partner.test": [v6("::ffff:10.0.0.7")] }),
    });
    expect(await guard.check("https://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "blocked-address",
    });
  });

  it("refuses a literal private address even when the tenant allowlisted it", async () => {
    const guard = createEgressGuard({
      policy: { allowedHosts: ["169.254.169.254", "127.0.0.1", "[::1]"] },
      resolve: resolverFor({}),
    });
    for (const url of ["https://169.254.169.254/", "https://127.0.0.1/", "https://[::1]/"]) {
      expect(await guard.check(url)).toMatchObject({ ok: false, reason: "blocked-address" });
    }
  });

  it("accepts an allowlisted host on a public address, and reports what it resolved to", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({ "api.partner.test": [v4("102.132.96.1"), v6("2606:4700::1")] }),
    });
    const verdict = await guard.check("https://api.partner.test/records?q=1");
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.target.addresses.map((a) => a.address)).toEqual(["102.132.96.1", "2606:4700::1"]);
  });

  it("matches a subdomain wildcard but never the apex it was written from", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({
        "eu.shard.partner.test": [v4("8.8.8.8")],
        "shard.partner.test": [v4("8.8.8.8")],
        "notshard.partner.test": [v4("8.8.8.8")],
      }),
    });
    expect(await guard.check("https://eu.shard.partner.test/x")).toMatchObject({ ok: true });
    expect(await guard.check("https://shard.partner.test/x")).toMatchObject({
      ok: false,
      reason: "host-not-allowed",
    });
    expect(await guard.check("https://notshard.partner.test/x")).toMatchObject({
      ok: false,
      reason: "host-not-allowed",
    });
  });

  it("is not fooled by case or a trailing dot", async () => {
    const guard = createEgressGuard({
      policy,
      resolve: resolverFor({ "api.partner.test": [v4("8.8.8.8")] }),
    });
    expect(await guard.check("https://API.Partner.Test./x")).toMatchObject({ ok: true });
  });

  it("reports an unresolvable host rather than throwing", async () => {
    const guard = createEgressGuard({ policy, resolve: resolverFor({}) });
    expect(await guard.check("https://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "unresolvable",
    });
  });

  it("refuses a tenant who declared no hosts at all", async () => {
    const guard = createEgressGuard({ policy: { allowedHosts: [] }, resolve: resolverFor({}) });
    expect(await guard.check("https://api.partner.test/x")).toMatchObject({
      ok: false,
      reason: "host-not-allowed",
    });
  });
});
