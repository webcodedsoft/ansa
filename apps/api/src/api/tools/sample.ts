import { createLogger, type OrganizationId } from "@ansa/shared";
import {
  createEgressGuard,
  createInMemoryVault,
  createTransport,
  type CredentialRef,
  type EgressGuard,
} from "@ansa/tools";

/**
 * One look at what an endpoint actually returns, while somebody is still writing the
 * sentence the agent will speak.
 *
 * The problem it exists for: `speech.template` is written against a response shape the
 * operator believes their endpoint has. When it is wrong the template renders its fallback,
 * the agent says "I couldn't find that policy", and nothing reports that the lookup in fact
 * succeeded and the field was called `status` rather than `state`. Until now the only way
 * to learn the real shape was to save the tool and run the sandbox — after the sentence had
 * already been written from memory.
 *
 * **This is a server-side fetch of a URL somebody typed, which is the shape of every SSRF.**
 * It is safe for one reason: it goes through `createEgressGuard`, the same guard the call
 * path uses, which refuses a non-https scheme, credentials in the userinfo, a private or
 * link-local address, a host that resolves to one, and a redirect to any of those. It
 * re-checks every hop and every resolved address rather than the first, because a host
 * answering with one public and one private address is the standard rebinding setup.
 *
 * The one check relaxed, deliberately: the **allowlist is the host being previewed** rather
 * than the organisation's saved list. That list is what stops the *model* reaching an
 * unlisted host mid-call. This is an authenticated operator asking to see a URL they are
 * about to save into it, and requiring it beforehand would mean adding a host to your egress
 * policy in order to find out whether you want it. Everything that makes SSRF dangerous —
 * reaching inside the network — is unaffected, because those checks are about the address.
 */

const log = createLogger({ component: "tool-sample" });

/** Enough to see the shape of a record. A response larger than this is not a lookup. */
const MAX_BYTES = 64 * 1024;

/** Longer than a call would ever wait, shorter than a browser giving up on the operator. */
const TIMEOUT_MS = 8_000;

export interface SampleRequest {
  readonly owner: OrganizationId;
  readonly url: string;
  readonly allowPlaintextHttp: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly credentialRef: string | null;
  readonly sealedCredentials: ReadonlyMap<string, string>;
  /**
   * Null when `TOOL_CREDENTIAL_KEY` is unset, which is a working deployment: a tool needing
   * a credential is simply never registered. A preview asking for one has to say so rather
   * than sending the request unauthenticated, which would either 401 confusingly or — far
   * worse — succeed against an endpoint that does not check.
   */
  readonly credentialKey: Buffer | null;
  /**
   * The guard to check the URL against. Built from the previewed host when absent, which is
   * what the controller does — it never passes one.
   *
   * Injected the same way `registerHttpTools` takes one, and for the same reason: the real
   * guard refuses loopback, correctly, so the success path cannot otherwise be exercised
   * against a local server. The refusal tests deliberately do *not* pass one, because what
   * they are proving is that the default is the real guard.
   */
  readonly guard?: EgressGuard;
}

export interface SampleResult {
  readonly ok: boolean;
  readonly status: number | null;
  /** Parsed JSON when it was JSON, otherwise null and `detail` explains. */
  readonly json: unknown;
  /** What went wrong, or the start of a body that was not JSON. Never a credential. */
  readonly detail: string | null;
}

const refused = (detail: string): SampleResult => ({ ok: false, status: null, json: null, detail });

/**
 * A refusal an operator can act on.
 *
 * The guard's own reasons are accurate and terse — `blocked-address`, `unresolvable` — and
 * somebody reading one on a form has no idea what to change. These say what happened and
 * what it means, without repeating the address into a screen somebody may screenshot.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  "malformed-url": "That is not a URL.",
  "scheme-not-allowed":
    "Only https is allowed. Turn on plaintext HTTP in the registry settings if this endpoint really is http.",
  "credentials-in-url":
    "The URL carries a username or password. Store it as a credential instead — the vault is the only place authentication belongs.",
  "host-not-allowed": "That host is not one this preview may reach.",
  "blocked-address":
    "That host resolves to a private or link-local address. An endpoint the agent can reach has to be reachable from the internet.",
  unresolvable: "That host does not resolve.",
};

export const fetchSample = async (request: SampleRequest): Promise<SampleResult> => {
  let host: string;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return refused(REFUSALS["malformed-url"] ?? "That is not a URL.");
  }

  const guard =
    request.guard ??
    createEgressGuard({
      policy: { allowedHosts: [host], allowPlaintextHttp: request.allowPlaintextHttp },
    });
  const transport = createTransport({ guard, maxBytes: MAX_BYTES, maxRedirects: 2 });

  const headers: Record<string, string> = { ...request.headers };
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "accept")) {
    headers["accept"] = "application/json";
  }

  if (request.credentialRef !== null) {
    if (request.credentialKey === null) {
      return refused(
        "This deployment has no credential key set, so stored credentials cannot be opened. The endpoint would be called unauthenticated.",
      );
    }
    const vault = createInMemoryVault(
      request.credentialKey,
      new Map([[request.owner, request.sealedCredentials]]),
    );
    const credential = await vault.resolve(request.owner, request.credentialRef as CredentialRef);
    if (credential === null) {
      return refused(`No credential named ${request.credentialRef} is stored.`);
    }
    // Applied the way the adapter applies it, so the preview sends what a call would send.
    // The value never comes back out: `SampleResult` carries no headers.
    credential.applyTo(headers);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await transport.send({
      url: request.url,
      method: "GET",
      headers,
      signal: controller.signal,
    });

    // Host and path only, never the query string: it carries the arguments somebody typed,
    // which against a real endpoint are somebody's identifiers.
    const target = new URL(request.url);
    log.info("sampled an endpoint", {
      organizationId: request.owner,
      endpoint: `${target.host}${target.pathname}`,
      status: response.status,
    });

    const text = response.body.trim();
    if (text === "") {
      return { ok: true, status: response.status, json: null, detail: "The response was empty." };
    }

    try {
      return { ok: true, status: response.status, json: JSON.parse(text) as unknown, detail: null };
    } catch {
      /* Not JSON, which is worth showing rather than hiding: an endpoint answering with a
         login page or a maintenance notice is the actual finding, and the adapter would
         refuse it on a call for the same reason. Truncated hard — an HTML page is long and
         none of it is useful. */
      return {
        ok: true,
        status: response.status,
        json: null,
        detail: `The response was not JSON. It began: ${text.slice(0, 200)}`,
      };
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const [key, message] of Object.entries(REFUSALS)) {
      if (reason.includes(key)) return refused(message);
    }
    // No body, no headers, no credential — the same rule the adapter follows, and for the
    // same reason: an endpoint's error page routinely quotes the request back at you.
    return refused(`The request did not complete: ${reason.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
};
