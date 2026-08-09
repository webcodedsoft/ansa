import { sealCredential } from "@ansa/tools";
import {
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Put,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody, FromPath } from "../http/request";
import { choice, flag, list, object, optional, text, type Infer } from "../http/schema";
import { timestamp } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

import { orRefuse } from "./refusals";
import {
  deleteCredential,
  listCredentials,
  putCredential,
  readConfiguration,
  sealedCredentials,
} from "./store";
import {
  classifyCredentials,
  FIELDS_FOR_SCHEME,
  referencedCredentials,
  toMaterial,
  vaultKey,
  type CredentialKind,
} from "./vault";

/**
 * The secrets an organisation's own systems check us with, and the ones we check theirs
 * with.
 *
 * **Write-only, and there is no way round that.** A credential goes in as plaintext, is
 * sealed with AES-256-GCM inside `@ansa/tools` — the tenant id and the reference name bound
 * into the authentication tag, so a ciphertext row copied between tenants will not open —
 * and the plaintext is never held in a field, never logged and never stored. Nothing here
 * reads one back. Not the plaintext, not the ciphertext, and not a masked form either: a
 * mask that preserves length tells an attacker whether they are looking at a 32-character
 * API key or a passphrase, and tells the person who typed it nothing they can act on. The
 * only remedy for a credential whose value is wrong is to replace it, which is what `PUT`
 * does.
 *
 * What is readable is the *name*, the two dates, whether the configuration points at it,
 * and which of the two kinds it is. That last one earns its place: an organisation whose
 * webhook receiver never verifies a signature usually has a signing secret stored as a
 * bearer token, and today the only symptom is a delivery failing hours later.
 */

/** The shape migration 0013's CHECK constraint puts on a credential name. */
const CREDENTIAL_REF = /^[a-z][a-z0-9_]{1,63}$/;

const credentialPath = object({ ref: text({ maxLength: 64, pattern: CREDENTIAL_REF }) });

const credential = object({
  ref: text({ maxLength: 64 }),
  /**
   * `auth` presents us to the organisation's server; `signing` lets their server check a
   * webhook came from us. The vault refuses to use one as the other, in both directions.
   * `unreadable` means the stored value will not open under the key this process holds —
   * a rotated key, or a row edited by hand — and the fix is to set it again.
   */
  kind: choice(["auth", "signing", "unreadable"]),
  /**
   * Whether this organisation's tool or event configuration names it.
   *
   * Read off the stored documents rather than the parsed ones, so it stays true for a
   * configuration that does not currently validate — a document written outside the
   * dashboard still points the call path at a credential.
   */
  inUse: flag(),
  createdAt: timestamp(),
  /** When the value was last replaced. There is no way to see what it was replaced with. */
  updatedAt: timestamp(),
});

const credentialList = object({ items: list(credential, { maxItems: 500 }) });

/**
 * One body for four schemes, because this schema language has no unions.
 *
 * `kind` selects which of the other fields are read; the rest are ignored. Which fields
 * each scheme needs is checked here so the refusal names them, and `sealCredential` checks
 * the material again — that second check is the one that counts, and it is the one that
 * refuses a header name that is not a header name and a signing secret short enough to
 * forge.
 *
 * There is no `query` scheme and there will not be. A URL is the one part of a request that
 * is logged by us, by the organisation's load balancer and by every proxy in between, so a
 * secret in a query string cannot satisfy R5.2.1 however careful the vault is.
 */
const newCredential = object({
  kind: choice(["bearer", "header", "basic", "signing"]),
  /** `bearer`: the token, sent as `Authorization: Bearer …`. */
  token: optional(text({ minLength: 1, maxLength: 4096 })),
  /** `header`: the header name. */
  header: optional(text({ minLength: 1, maxLength: 64 })),
  /** `header`: its value. */
  value: optional(text({ minLength: 1, maxLength: 4096 })),
  /** `basic`: the two halves, sent base64 in `Authorization`. */
  username: optional(text({ minLength: 1, maxLength: 1024 })),
  password: optional(text({ minLength: 1, maxLength: 1024 })),
  /** `signing`: the shared secret a webhook receiver verifies with. At least 16 characters. */
  secret: optional(text({ minLength: 1, maxLength: 4096 })),
});

const storedCredential = object({
  ref: text({ maxLength: 64 }),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const NO_VAULT_KEY =
  "this deployment holds no credential key, so a credential cannot be sealed or read back";

@Controller(apiRoute("credentials"))
export class CredentialsController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "The credentials this organisation has stored, by name",
    description:
      "Names, kinds and dates. No credential value is returned by this API in any form, including masked.",
    capability: "config:read",
    response: credentialList,
  })
  async list(): Promise<Infer<typeof credentialList>> {
    return this.db.tx(async (scope) => {
      const stored = await listCredentials(scope);
      const configuration = await readConfiguration(scope);
      const referenced = referencedCredentials([
        configuration?.toolConfig,
        configuration?.eventConfig,
      ]);

      const sealed = await sealedCredentials(scope);
      const key = vaultKey();
      const kinds = key === null ? null : await classifyCredentials(key, scope.tenantId, sealed);

      return {
        items: stored.map((entry) => ({
          ref: entry.ref,
          // Without a key nothing can be opened, so nothing can be classified either.
          kind: (kinds?.get(entry.ref) ?? "unreadable") satisfies CredentialKind,
          inUse: referenced.has(entry.ref),
          createdAt: entry.createdAt.toISOString(),
          updatedAt: entry.updatedAt.toISOString(),
        })),
      };
    });
  }

  @Put(":ref")
  @Endpoint({
    summary: "Store a credential under this name, or replace the one already there",
    description:
      "Write-only. The value is sealed before it reaches the database and is not recoverable through this API — rotate rather than recover. Rotating takes effect on the next call; a call in progress keeps the credential it already resolved.",
    capability: "config:write",
    params: credentialPath,
    body: newCredential,
    response: storedCredential,
  })
  async put(
    @FromPath() path: Infer<typeof credentialPath>,
    @FromBody() body: Infer<typeof newCredential>,
  ): Promise<Infer<typeof storedCredential>> {
    const key = vaultKey();
    // 503 rather than 422: nothing about the request is wrong, and telling the caller their
    // credential was rejected would send them looking in the wrong place.
    if (key === null) throw new ServiceUnavailableException(NO_VAULT_KEY);

    const material = toMaterial(body);
    if (material === null) {
      const needed = FIELDS_FOR_SCHEME[body.kind] ?? [];
      throw new UnprocessableEntityException(
        `a ${body.kind} credential needs ${needed.join(" and ")}`,
      );
    }

    return this.db.tx(async (scope) => {
      // `sealCredential` is the refusal that counts, and its message never quotes the value
      // — it says what is wrong with the shape. `orRefuse` turns it into a 422.
      const sealed = orRefuse(() => sealCredential(key, scope.tenantId, path.ref, material));
      const written = await putCredential(scope, path.ref, sealed);
      return {
        ref: written.ref,
        createdAt: written.createdAt.toISOString(),
        updatedAt: written.updatedAt.toISOString(),
      };
    });
  }

  @Delete(":ref")
  @Endpoint({
    summary: "Remove a credential",
    description:
      "Refused with 409 while the tool or event configuration still names it, because removing it would leave a tool that registers and then refuses every caller.",
    capability: "config:write",
    params: credentialPath,
  })
  async remove(@FromPath() path: Infer<typeof credentialPath>): Promise<void> {
    await this.db.tx(async (scope) => {
      const configuration = await readConfiguration(scope);
      const referenced = referencedCredentials([
        configuration?.toolConfig,
        configuration?.eventConfig,
      ]);
      if (referenced.has(path.ref)) {
        throw new ConflictException(
          `${path.ref} is still named by this organisation's tool or event configuration; ` +
            "publish a configuration that does not use it first",
        );
      }

      const removed = await deleteCredential(scope, path.ref);
      // Not stored here — which, under RLS, is also what another organisation's credential
      // looks like. Answering 404 to both is the point.
      if (!removed) throw new NotFoundException();
    });
  }
}
