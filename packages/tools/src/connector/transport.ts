import { Agent as HttpAgent, request as httpRequest, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

import type { EgressGuard, EgressRefusal, ResolvedAddress } from "./egress";

/**
 * The one way this product makes an outbound request to somebody else's server.
 *
 * `fetch` would be shorter and cannot be used: it gives no way to pin the address a
 * connection goes to, so the host is resolved a second time inside undici after our guard
 * has already approved the first resolution. That gap is DNS rebinding, and it is the
 * whole attack. `node:http`'s `lookup` option closes it by handing the socket the
 * addresses that were checked rather than a hostname to re-resolve.
 *
 * No new dependency: `node:http`, `node:https` and the guard.
 */

export interface ConnectorRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * Header names that carry a secret, dropped when a redirect changes origin.
   *
   * Named by the caller because only the caller knows: a vault credential can be a bearer
   * token, basic auth, or a header of the organisation's own choosing, and `x-api-key` is
   * as much a secret as `authorization`. Same rule browsers and curl follow, and it matters
   * here in particular because the allowlist a redirect is checked against accumulates —
   * every tool save adds its host and nothing ever removes one.
   */
  readonly sensitiveHeaders?: readonly string[];
  /**
   * When to give up, decided by the caller rather than here.
   *
   * The dispatcher passes its hard ceiling, which is three seconds because a caller is
   * waiting. Nothing in this file assumes that: event delivery to the same organisation
   * (TASKS.md, Slice 6a) happens after the call and should be allowed to take longer and
   * to retry with backoff. Baking the voice budget in here would mean a second HTTP
   * client for the other path, which would be a second place a redirect gets followed.
   */
  readonly signal: AbortSignal;
}

export interface ConnectorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A refusal is not an exception — it is the expected outcome of a organization pointing at
 * something they are not allowed to reach, and the caller logs it and speaks an apology.
 */
export class EgressRefusedError extends Error {
  constructor(
    readonly reason: EgressRefusal,
    detail: string,
  ) {
    super(`egress refused (${reason}): ${detail}`);
    this.name = "EgressRefusedError";
  }
}

export interface Transport {
  send(request: ConnectorRequest): Promise<ConnectorResponse>;
}

export interface TransportOptions {
  readonly guard: EgressGuard;
  /**
   * A organization endpoint that streams forever must not take the process down with it. The
   * default is generous for a JSON tool result and small enough to be harmless.
   */
  readonly maxBytes?: number;
  /**
   * Redirects are followed, and every hop is re-checked by the guard. Kept low because a
   * chain of them spends the caller's three seconds on nothing.
   */
  readonly maxRedirects?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_REDIRECTS = 2;

/**
 * Connection reuse, which is worth real milliseconds on a voice call — the first TTS
 * request of a call measured 472ms against 250ms once its socket was warm, and a tool
 * endpoint pays the same TLS handshake.
 */
const httpsAgent = new HttpsAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000 });
const httpAgent = new HttpAgent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 30_000 });

/**
 * Hands the socket the addresses the guard approved and nothing else.
 *
 * Node calls this instead of `dns.lookup`, so there is no second resolution and therefore
 * no window in which the answer can change.
 */
const pinnedLookup =
  (addresses: readonly ResolvedAddress[]): RequestOptions["lookup"] =>
  (_hostname, options, callback) => {
    const all = addresses.map((entry) => ({ address: entry.address, family: entry.family }));
    const wanted =
      typeof options === "object" && options !== null && typeof options.family === "number" && options.family !== 0
        ? all.filter((entry) => entry.family === options.family)
        : all;
    const chosen = wanted.length > 0 ? wanted : all;
    const first = chosen[0];
    if (first === undefined) {
      callback(new Error("no vetted address for this host"), "", 4);
      return;
    }
    if (typeof options === "object" && options !== null && options.all === true) {
      // The overloads for `all: true` and `all: false` are genuinely different callbacks
      // and Node picks by the option, which the type cannot express at this call site.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (callback as any)(null, chosen);
      return;
    }
    callback(null, first.address, first.family);
  };

const headerRecord = (raw: NodeJS.Dict<string | string[]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
};

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

const sendOne = async (
  request: ConnectorRequest,
  url: URL,
  addresses: readonly ResolvedAddress[],
  maxBytes: number,
): Promise<ConnectorResponse> =>
  new Promise<ConnectorResponse>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    // `URL.hostname` keeps the brackets around an IPv6 literal and `http.request` does
    // not want them on `hostname` — only on the Host header, which comes from `url.host`.
    const hostname = url.hostname.replace(/^\[/, "").replace(/\]$/, "");

    const outgoing = send(
      {
        protocol: url.protocol,
        hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers: { ...request.headers, host: url.host },
        agent: secure ? httpsAgent : httpAgent,
        lookup: pinnedLookup(addresses),
        // The name presented in the TLS handshake stays the hostname even though the
        // connection is made to a pinned address; without this, pinning would break
        // certificate validation and the fix would be to disable it.
        servername: secure && !hostname.includes(":") ? hostname : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(new Error(`response exceeded ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: headerRecord(response.headers),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );

    const abort = () => outgoing.destroy(new Error("aborted"));
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.on("close", () => request.signal.removeEventListener("abort", abort));

    outgoing.on("error", reject);
    if (request.body !== undefined) outgoing.write(request.body);
    outgoing.end();
  });

/**
 * Guard, then connect to what the guard approved, then guard the redirect too.
 *
 * Shared by both connector routes. The HTTP tool and the MCP client differ in what they
 * put in the body; neither of them gets to decide where the body goes.
 */
export const createTransport = (options: TransportOptions): Transport => {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return {
    async send(request) {
      let url = request.url;
      let method = request.method;
      let body = request.body;
      let headers = request.headers;
      const sensitive = new Set((request.sensitiveHeaders ?? []).map((name) => name.toLowerCase()));

      for (let hop = 0; ; hop += 1) {
        const verdict = await options.guard.check(url);
        if (!verdict.ok) throw new EgressRefusedError(verdict.reason, verdict.detail);

        const response = await sendOne(
          { ...request, url, method, body, headers },
          verdict.target.url,
          verdict.target.addresses,
          maxBytes,
        );

        const location = response.headers.location;
        if (!REDIRECT_CODES.has(response.status) || location === undefined) return response;
        if (hop >= maxRedirects) throw new Error(`too many redirects (${maxRedirects})`);

        // Resolved against the hop we are on, so a relative Location is handled and a
        // scheme downgrade in an absolute one is caught by the guard on the next pass.
        const next = new URL(location, verdict.target.url);
        if (next.origin !== verdict.target.url.origin && sensitive.size > 0) {
          // The credential was sealed for the host the operator configured. A server that
          // answers 302 has chosen the next host itself, and the allowlist it is checked
          // against still holds every host this organisation has ever saved a tool for.
          headers = Object.fromEntries(
            Object.entries(headers).filter(([name]) => !sensitive.has(name.toLowerCase())),
          );
        }
        url = next.toString();
        if (response.status === 303 || response.status === 301 || response.status === 302) {
          // Standard behaviour, and the safer one: the body is not replayed to a host the
          // original request was not addressed to.
          method = method === "HEAD" ? "HEAD" : "GET";
          body = undefined;
        }
      }
    },
  };
};
