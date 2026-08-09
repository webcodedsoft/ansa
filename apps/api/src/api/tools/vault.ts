import type { TenantId } from "@ansa/shared";
import {
  createInMemoryVault,
  type ConnectorConfig,
  type CredentialMaterial,
  type EventConfig,
} from "@ansa/tools";

/**
 * Everything this endpoint area does with secret material, in one file so that "where can
 * a credential go?" has a short answer.
 *
 * The answer is: in, and nowhere else. `sealCredential` turns plaintext into ciphertext
 * inside `@ansa/tools` and the plaintext is never held in a field, never logged, never put
 * in an exception message and never stored. Coming back out, the only thing this file asks
 * the vault is *which kind* a sealed value is — a question answered by decrypting into a
 * closure the vault owns and returning an object with no `reveal()`. The dashboard learns
 * "that is a signing secret" and cannot learn one byte of it.
 *
 * There is no read endpoint for a credential value. Not plaintext, not ciphertext, not a
 * masked form: a mask that preserves length distinguishes a 32-character API key from a
 * passphrase, which is information an attacker can use and a legitimate reader cannot.
 *
 * The tenant id is called `owner` here for the reason `refusals.ts` explains: it goes into
 * an AES-GCM authentication tag, not into a query, and `routes.test.ts` is right to be
 * blunt about a tenant id in an argument list.
 */

/** 32 bytes, base64, from the process environment. Never from the database, never a tenant's. */
const KEY_BYTES = 32;

/**
 * The vault key, or null when this deployment has none.
 *
 * Null is a working configuration: a tenant can register tools that need no credential, and
 * `prepareConnectors` already drops the ones that do rather than making an anonymous
 * request to somebody's customer API. What null cannot do is seal, so the write endpoint
 * answers 503 rather than pretending.
 *
 * A key of the wrong length throws, matching `apps/api/src/config/env.ts`, which throws at
 * boot for the same reason: a bad key makes every credential in the vault unopenable, and
 * that must not present as "this organisation's tools are all broken".
 */
export const vaultKey = (env: NodeJS.ProcessEnv = process.env): Buffer | null => {
  const raw = env["TOOL_CREDENTIAL_KEY"];
  if (raw === undefined || raw.trim() === "") return null;
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("TOOL_CREDENTIAL_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  }
  return key;
};

/**
 * What a stored credential is for, without saying what it is.
 *
 * `unreadable` is its own answer rather than an error: it means the ciphertext will not
 * open under the key this process holds — a rotated key, a hand-edited row — and the tenant
 * needs to see that on a screen, because otherwise it surfaces as a tool that fails on
 * every call for no visible reason.
 */
export type CredentialKind = "auth" | "signing" | "unreadable";

/**
 * Classify one sealed value by asking the vault to open it both ways.
 *
 * `resolve` refuses a signing secret and `resolveSigner` refuses an auth credential — the
 * vault keeps them apart on purpose, because a receiver holds the signing secret and it
 * must never turn out to be the token that opens the tenant's own API. That refusal is what
 * this reads as a type tag.
 */
export const classifyCredentials = async (
  key: Buffer,
  owner: TenantId,
  sealed: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, CredentialKind>> => {
  const vault = createInMemoryVault(key, new Map([[owner, sealed]]));
  const kinds = new Map<string, CredentialKind>();

  for (const ref of sealed.keys()) {
    let kind: CredentialKind = "unreadable";
    try {
      if ((await vault.resolve(owner, ref)) !== null) kind = "auth";
    } catch {
      // Either a signing secret, which resolve() refuses by design, or ciphertext that will
      // not open. The next call tells the two apart.
    }
    if (kind === "unreadable") {
      try {
        if ((await vault.resolveSigner(owner, ref)) !== null) kind = "signing";
      } catch {
        // Will not open under this key at all. Left as `unreadable`, which is the answer.
      }
    }
    kinds.set(ref, kind);
  }

  return kinds;
};

/** One place a configuration names a credential, and what that place needs it to be. */
export interface CredentialUse {
  readonly ref: string;
  readonly needs: "auth" | "signing";
  /** Where in the configuration, for the refusal message. */
  readonly where: string;
}

/** Every credential the two configurations point at, read off the parsed shapes. */
export const credentialUses = (
  tools: ConnectorConfig,
  events: EventConfig,
): readonly CredentialUse[] => {
  const uses: CredentialUse[] = [];

  for (const tool of tools.http) {
    if (tool.credentialRef !== undefined) {
      uses.push({ ref: tool.credentialRef, needs: "auth", where: `tools.http[${tool.name}]` });
    }
  }
  for (const [index, server] of tools.mcp.entries()) {
    if (server.credentialRef !== undefined) {
      uses.push({ ref: server.credentialRef, needs: "auth", where: `tools.mcp[${index}]` });
    }
  }
  for (const subscription of events.subscriptions) {
    uses.push({
      ref: subscription.signingSecretRef,
      needs: "signing",
      where: `events.${subscription.name}.signingSecretRef`,
    });
    if (subscription.credentialRef !== undefined) {
      uses.push({
        ref: subscription.credentialRef,
        needs: "auth",
        where: `events.${subscription.name}.credentialRef`,
      });
    }
  }

  return uses;
};

/**
 * A configuration pointing at a credential that is missing, or is the other kind.
 *
 * Both are publication-time mistakes with an invisible runtime cost. A missing reference
 * makes the tool register and then refuse every caller — `http.ts` will not send the
 * request unauthenticated, which is right and looks like "sorry, I couldn't get that just
 * now". A signing secret used as an auth credential makes the vault throw on the first
 * delivery, hours after anyone was looking.
 *
 * `kinds` is null when this deployment has no vault key. Existence is still checked; the
 * kind is not, because nothing here can open a sealed value to find out.
 */
export const refuseUnusableReferences = (
  uses: readonly CredentialUse[],
  known: ReadonlySet<string>,
  kinds: ReadonlyMap<string, CredentialKind> | null,
): void => {
  for (const use of uses) {
    if (!known.has(use.ref)) {
      throw new Error(
        `${use.where} names the credential ${use.ref}, which this organisation has not stored`,
      );
    }
    const kind = kinds?.get(use.ref);
    if (kind === undefined) continue;
    if (kind === "unreadable") {
      throw new Error(
        `${use.where} names the credential ${use.ref}, whose stored value will not open — replace it`,
      );
    }
    if (kind !== use.needs) {
      throw new Error(
        `${use.where} needs a ${use.needs} credential and ${use.ref} is a ${kind} one; ` +
          "the two are deliberately not interchangeable",
      );
    }
  }
};

const REFERENCE_KEYS = new Set(["credentialRef", "signingSecretRef"]);

/**
 * Every credential name a stored document mentions, found by walking the raw JSON.
 *
 * Deliberately untyped, unlike `credentialUses` above. This one answers "is it safe to
 * delete this credential?", and it has to keep answering when the stored configuration does
 * not validate — a document written by hand in psql still points the call path at a
 * credential, and deleting one it names would break tools that are otherwise working.
 * Guessing "not referenced" because the document failed to parse is the wrong direction.
 */
export const referencedCredentials = (documents: readonly unknown[]): ReadonlySet<string> => {
  const found = new Set<string>();

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (REFERENCE_KEYS.has(key) && typeof child === "string" && child.trim() !== "") {
        found.add(child.trim());
      }
      walk(child);
    }
  };

  for (const document of documents) walk(document);
  return found;
};

/**
 * The four schemes, built from a request body.
 *
 * Returns null for anything that is not one of them, which the caller turns into a 422.
 * `sealCredential` refuses the same shapes again — a header name that is not a header name,
 * a signing secret short enough to forge — and that refusal is the one that counts. This is
 * here so the message names the field.
 */
export interface CredentialInput {
  readonly kind: string;
  readonly token?: string;
  readonly header?: string;
  readonly value?: string;
  readonly username?: string;
  readonly password?: string;
  readonly secret?: string;
}

export const toMaterial = (input: CredentialInput): CredentialMaterial | null => {
  switch (input.kind) {
    case "bearer":
      return input.token === undefined ? null : { kind: "bearer", token: input.token };
    case "header":
      return input.header === undefined || input.value === undefined
        ? null
        : { kind: "header", header: input.header, value: input.value };
    case "basic":
      return input.username === undefined || input.password === undefined
        ? null
        : { kind: "basic", username: input.username, password: input.password };
    case "signing":
      return input.secret === undefined ? null : { kind: "signing", secret: input.secret };
    default:
      return null;
  }
};

/** Which fields each scheme needs, for a refusal that says so rather than "unsupported". */
export const FIELDS_FOR_SCHEME: Readonly<Record<string, readonly string[]>> = {
  bearer: ["token"],
  header: ["header", "value"],
  basic: ["username", "password"],
  signing: ["secret"],
};
