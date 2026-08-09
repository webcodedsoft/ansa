import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * R5.2.2. The tenant supplies the URL, so the URL is hostile input.
 *
 * This is not a formality. A connector is "make an HTTP request to a string somebody
 * else wrote", which is the textbook shape of SSRF: the string can name our own database,
 * the cloud provider's metadata endpoint, or a host that resolves publicly at check time
 * and privately a millisecond later. Three separate defences, because each one alone is
 * defeated by an attack the other two catch:
 *
 *   1. an allowlist of hosts the tenant declared, so an arbitrary host is refused before
 *      anything is resolved;
 *   2. an address filter over every address the host resolves to, so an allowlisted host
 *      pointed at 169.254.169.254 is refused as well;
 *   3. pinning — the addresses that passed (2) are the only ones the socket may connect
 *      to, which is what closes the gap between checking and connecting (see transport.ts).
 *
 * Redirects go through the whole thing again, because a redirect is a second URL that the
 * tenant's server chose rather than the tenant's operator.
 */

/** Per tenant, and never inferred: a tenant that declared no hosts can reach none. */
export interface EgressPolicy {
  /**
   * Exact hostnames, or `*.example.com` for a subdomain wildcard.
   *
   * A wildcard deliberately does not match the apex — `*.example.com` does not permit
   * `example.com` — because the two are frequently different services and a wildcard is
   * usually written to cover one shard of many, not the front door.
   */
  readonly allowedHosts: readonly string[];
  /**
   * Plaintext HTTP, off by default.
   *
   * A tool call carries a credential and often a caller's identifiers, and this product
   * runs over networks it does not own. A tenant whose internal API is HTTP-only has to
   * say so, in configuration, in writing.
   */
  readonly allowPlaintextHttp?: boolean;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface EgressTarget {
  readonly url: URL;
  /** Every address the host resolved to, all of which passed the filter. */
  readonly addresses: readonly ResolvedAddress[];
}

export type EgressRefusal =
  | "malformed-url"
  | "scheme-not-allowed"
  | "credentials-in-url"
  | "host-not-allowed"
  | "unresolvable"
  | "blocked-address";

export type EgressVerdict =
  | { readonly ok: true; readonly target: EgressTarget }
  | { readonly ok: false; readonly reason: EgressRefusal; readonly detail: string };

/**
 * The seam the transport talks to.
 *
 * An interface rather than a function so tests can supply one that permits loopback —
 * there is no configuration flag that turns the address filter off, because a flag that
 * exists in the type is a flag a tenant's configuration can eventually reach.
 */
export interface EgressGuard {
  check(rawUrl: string): Promise<EgressVerdict>;
}

/** Injected so the DNS-rebinding and blocked-address tests do not need the network. */
export type AddressResolver = (host: string) => Promise<readonly ResolvedAddress[]>;

const ipv4Bytes = (text: string): Uint8Array | null => {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index];
    if (part === undefined || !/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
};

/**
 * Expands every IPv6 form to sixteen bytes, including the dotted-quad tail.
 *
 * The dotted tail is the whole reason this is hand-written rather than a string compare:
 * `::ffff:169.254.169.254` and `[::ffff:a9fe:a9fe]` are the same address as
 * `169.254.169.254`, and a filter that only knows the third one is not a filter.
 */
const ipv6Bytes = (text: string): Uint8Array | null => {
  const zoned = text.indexOf("%");
  let head = zoned < 0 ? text : text.slice(0, zoned);

  const lastColon = head.lastIndexOf(":");
  if (lastColon < 0) return null;
  const tail = head.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = ipv4Bytes(tail);
    if (embedded === null) return null;
    const high = (((embedded[0] ?? 0) << 8) | (embedded[1] ?? 0)).toString(16);
    const low = (((embedded[2] ?? 0) << 8) | (embedded[3] ?? 0)).toString(16);
    head = `${head.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = head.split("::");
  if (halves.length > 2) return null;
  const leftText = halves[0] ?? "";
  const rightText = halves.length === 2 ? (halves[1] ?? "") : "";
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");

  let groups: string[];
  if (halves.length === 1) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const group = groups[index];
    if (group === undefined || !/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
};

/**
 * Everything that is not a routable public IPv4 address.
 *
 * Written as ranges rather than as a list of known metadata endpoints on purpose: every
 * cloud metadata address in use today already falls inside one of these, and the ones that
 * do not exist yet will too. A list of literals would be out of date the week it shipped.
 *
 *   169.254.0.0/16   link-local — AWS, GCP and Azure metadata at 169.254.169.254,
 *                    ECS task credentials at 169.254.170.2
 *   100.64.0.0/10    carrier NAT — Alibaba metadata at 100.100.100.200
 *   192.0.0.0/24     IETF assignments — Oracle metadata at 192.0.0.192
 */
const blockedV4 = (b: Uint8Array): boolean => {
  const a0 = b[0] ?? 0;
  const a1 = b[1] ?? 0;
  const a2 = b[2] ?? 0;
  return (
    a0 === 0 ||
    a0 === 10 ||
    a0 === 127 ||
    (a0 === 100 && a1 >= 64 && a1 <= 127) ||
    (a0 === 169 && a1 === 254) ||
    (a0 === 172 && a1 >= 16 && a1 <= 31) ||
    (a0 === 192 && a1 === 0 && a2 === 0) ||
    (a0 === 192 && a1 === 0 && a2 === 2) ||
    (a0 === 192 && a1 === 88 && a2 === 99) ||
    (a0 === 192 && a1 === 168) ||
    (a0 === 198 && (a1 === 18 || a1 === 19)) ||
    (a0 === 198 && a1 === 51 && a2 === 100) ||
    (a0 === 203 && a1 === 0 && a2 === 113) ||
    // Multicast, reserved and broadcast. Nothing a tenant API is served from.
    a0 >= 224
  );
};

const allZero = (b: Uint8Array, from: number, to: number): boolean => {
  for (let index = from; index < to; index += 1) if ((b[index] ?? 0) !== 0) return false;
  return true;
};

/**
 * IPv6, including every form that carries an IPv4 address inside it.
 *
 * The embedded cases are the ones an attacker reaches for second: `::ffff:169.254.169.254`
 * (v4-mapped), `64:ff9b::169.254.169.254` (NAT64) and `2002:a9fe:a9fe::` (6to4) all reach
 * the same metadata service through a stack that will happily route them.
 */
const blockedV6 = (b: Uint8Array): boolean => {
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;

  // Unspecified (::) and loopback (::1).
  if (allZero(b, 0, 15) && ((b[15] ?? 0) === 0 || (b[15] ?? 0) === 1)) return true;
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8.
  if ((b0 & 0xfe) === 0xfc) return true;
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  if (b0 === 0xff) return true;
  // Discard-only 100::/64 and documentation 2001:db8::/32.
  if (b0 === 0x01 && b1 === 0x00 && allZero(b, 2, 8)) return true;
  if (b0 === 0x20 && b1 === 0x01 && (b[2] ?? 0) === 0x0d && (b[3] ?? 0) === 0xb8) return true;

  // IPv4-mapped ::ffff:0:0/96 and the deprecated IPv4-compatible ::/96.
  if (allZero(b, 0, 10) && (((b[10] ?? 0) === 0xff && (b[11] ?? 0) === 0xff) || allZero(b, 10, 12))) {
    return blockedV4(b.slice(12, 16));
  }
  // NAT64 well-known 64:ff9b::/96 and the local-use 64:ff9b:1::/48.
  if (b0 === 0x00 && b1 === 0x64 && (b[2] ?? 0) === 0xff && (b[3] ?? 0) === 0x9b) {
    return (b[4] ?? 0) === 0x00 && (b[5] ?? 0) === 0x01 ? true : blockedV4(b.slice(12, 16));
  }
  // 6to4 2002::/16 carries the IPv4 address in bytes 2-5.
  if (b0 === 0x20 && b1 === 0x02) return blockedV4(b.slice(2, 6));

  return false;
};

/**
 * True for anything that is not a routable public address, and for anything unparseable.
 *
 * Fails closed: an address shape this does not understand is refused rather than allowed,
 * because "we have never seen that form" is exactly the condition an attacker is looking
 * for.
 */
export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return bytes === null ? true : blockedV4(bytes);
  }
  if (family === 6) {
    const bytes = ipv6Bytes(address);
    return bytes === null ? true : blockedV6(bytes);
  }
  return true;
};

/**
 * One spelling of a host.
 *
 * Three normalisations, each of which was a real hole: the trailing dot that makes a
 * fully-qualified name (`example.com.`) a different string from the one the tenant wrote,
 * the case that DNS does not care about, and the brackets that `URL.hostname` keeps around
 * an IPv6 literal — `[::1]` is not an IP address as far as `isIP` is concerned, so without
 * this the literal-address branch is skipped and loopback goes to the resolver instead of
 * to the filter.
 */
const normaliseHost = (host: string): string =>
  host.trim().toLowerCase().replace(/\.$/, "").replace(/^\[/, "").replace(/\]$/, "");

/**
 * Allowlist matching.
 *
 * Bracketed IPv6 literals arrive from `URL.hostname` without brackets, so a tenant who
 * allowlists a literal address writes it the way it is written everywhere else. Matching
 * is on the host string; whether the address behind it is reachable is a separate
 * question answered below, and both have to pass.
 */
/**
 * Exported because configuration is checked against the same rule the guard enforces.
 *
 * `parseConnectorConfig` refuses a tool whose URL sits outside the allowlist the same
 * tenant declared beside it. That is not a second boundary — this function is still the
 * only definition of "allowed", and the guard below is still the thing standing between a
 * request and the network. It is validation, so a mistake surfaces at publication time
 * rather than as a tool the model is told it has and that refuses every caller.
 */
export const isHostAllowed = (host: string, allowed: readonly string[]): boolean => {
  const target = normaliseHost(host);
  for (const raw of allowed) {
    const entry = normaliseHost(raw);
    if (entry === "") continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      if (target.endsWith(suffix) && target.length > suffix.length) return true;
      continue;
    }
    if (entry === target) return true;
  }
  return false;
};

const systemResolver: AddressResolver = async (host) => {
  // verbatim so the order the resolver returned is preserved; every address is checked
  // regardless, so ordering only affects which one the socket tries first.
  const found = await dnsLookup(host, { all: true, verbatim: true });
  return found.map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));
};

export interface EgressGuardOptions {
  readonly policy: EgressPolicy;
  readonly resolve?: AddressResolver;
}

/**
 * The guard for one tenant's policy.
 *
 * Returns a verdict rather than throwing: a refusal is a routine outcome that the caller
 * turns into a spoken apology and a log line, not an exception path.
 */
export const createEgressGuard = (options: EgressGuardOptions): EgressGuard => {
  const { policy } = options;
  const resolve = options.resolve ?? systemResolver;

  return {
    async check(rawUrl) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { ok: false, reason: "malformed-url", detail: "not a URL" };
      }

      const plaintext = policy.allowPlaintextHttp === true;
      if (url.protocol !== "https:" && !(plaintext && url.protocol === "http:")) {
        return { ok: false, reason: "scheme-not-allowed", detail: url.protocol };
      }
      // `file:`, `gopher:` and friends are covered above; this catches the other half of
      // the classic payload, where the interesting part of the URL is the userinfo.
      if (url.username !== "" || url.password !== "") {
        return { ok: false, reason: "credentials-in-url", detail: url.hostname };
      }
      const host = normaliseHost(url.hostname);
      if (!isHostAllowed(host, policy.allowedHosts)) {
        return { ok: false, reason: "host-not-allowed", detail: host };
      }

      const literal = isIP(host);
      if (literal !== 0) {
        if (isBlockedAddress(host)) {
          return { ok: false, reason: "blocked-address", detail: host };
        }
        return { ok: true, target: { url, addresses: [{ address: host, family: literal === 6 ? 6 : 4 }] } };
      }

      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await resolve(host);
      } catch (error) {
        return {
          ok: false,
          reason: "unresolvable",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (addresses.length === 0) {
        return { ok: false, reason: "unresolvable", detail: host };
      }

      // Every address, not the first. A host that answers with one public address and one
      // private one is the standard DNS-rebinding setup, and taking the first would make
      // the outcome a coin toss.
      for (const entry of addresses) {
        if (isBlockedAddress(entry.address)) {
          return { ok: false, reason: "blocked-address", detail: entry.address };
        }
      }

      return { ok: true, target: { url, addresses } };
    },
  };
};
