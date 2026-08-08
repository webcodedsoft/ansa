import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { TenantId } from "@ansa/shared";

/**
 * R5.2.1. Per-tenant encrypted credential vault.
 *
 * "Never in logs, never in the LLM context, never in a transcript" is a property of where
 * the plaintext can go, so the design is about reachability rather than about discipline:
 *
 *   - the plaintext lives in a closure and is never a field on anything;
 *   - the only thing that leaves this module is a `Credential`, whose one useful method
 *     writes headers into an object it is handed;
 *   - `toJSON` and `toString` on that object both return `[redacted]`, so the two ways a
 *     value accidentally reaches a log line — `JSON.stringify` of a fields object, and
 *     string interpolation — both produce nothing.
 *
 * There is no `reveal()`. If one is ever added, it becomes the thing to grep for.
 */

/** A name in the tenant's own configuration. Not a secret; it is a pointer to one. */
export type CredentialRef = string;

/**
 * How the secret is presented to the tenant's endpoint.
 *
 * Deliberately header-only. Query-string API keys exist and are refused: the URL is the
 * one part of a request that is logged by us, by the tenant's load balancer and by every
 * proxy in between, and a scheme that puts the secret there cannot satisfy R5.2.1 no
 * matter how careful this file is.
 */
export type CredentialMaterial =
  | { readonly kind: "bearer"; readonly token: string }
  | { readonly kind: "header"; readonly header: string; readonly value: string }
  | { readonly kind: "basic"; readonly username: string; readonly password: string };

export interface Credential {
  /** Mutates the header map in place, at the last possible moment before the request. */
  applyTo(headers: Record<string, string>): void;
  toJSON(): string;
  toString(): string;
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

const opaque = (material: CredentialMaterial): Credential => {
  const credential: Credential = {
    applyTo(headers) {
      switch (material.kind) {
        case "bearer":
          headers.authorization = `Bearer ${material.token}`;
          return;
        case "basic":
          headers.authorization = `Basic ${Buffer.from(`${material.username}:${material.password}`).toString("base64")}`;
          return;
        case "header":
          headers[material.header.toLowerCase()] = material.value;
          return;
      }
    },
    toJSON: () => "[redacted]",
    toString: () => "[redacted]",
  };
  // `console.log(credential)` and Nest's default logger both go through inspect, which
  // ignores toJSON. This is the third door and it is shut for the same reason.
  Object.defineProperty(credential, Symbol.for("nodejs.util.inspect.custom"), {
    value: () => "[redacted]",
    enumerable: false,
  });
  return credential;
};

const isMaterial = (value: unknown): value is CredentialMaterial => {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "bearer") return typeof raw.token === "string" && raw.token !== "";
  if (raw.kind === "basic") return typeof raw.username === "string" && typeof raw.password === "string";
  if (raw.kind === "header") {
    return typeof raw.header === "string" && HEADER_NAME.test(raw.header) && typeof raw.value === "string";
  }
  return false;
};

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * AES-256-GCM, with the tenant and the reference name as additional authenticated data.
 *
 * The AAD is the part worth explaining. Without it, a ciphertext row is portable: anyone
 * who can write to the credentials table can copy tenant A's sealed value into tenant B's
 * row and the vault will happily decrypt it, which turns a write bug into a cross-tenant
 * credential leak. Binding the tenant id and the ref into the tag makes that ciphertext
 * fail to open anywhere except where it was sealed.
 */
const aad = (tenantId: TenantId, ref: CredentialRef): Buffer => Buffer.from(`${tenantId}:${ref}`, "utf8");

const requireKey = (key: Buffer): Buffer => {
  if (key.length !== KEY_BYTES) {
    throw new Error(`credential vault: key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
};

/** Onboarding writes ciphertext with this; nothing on the call path calls it. */
export const sealCredential = (
  key: Buffer,
  tenantId: TenantId,
  ref: CredentialRef,
  material: CredentialMaterial,
): string => {
  if (!isMaterial(material)) throw new Error("credential vault: unsupported credential material");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", requireKey(key), iv, { authTagLength: 16 });
  cipher.setAAD(aad(tenantId, ref));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(material), "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), sealed.toString("base64")].join(".");
};

const openCredential = (
  key: Buffer,
  tenantId: TenantId,
  ref: CredentialRef,
  sealed: string,
): CredentialMaterial => {
  const parts = sealed.split(".");
  const [version, iv, tag, payload] = parts;
  if (parts.length !== 4 || version !== VERSION || iv === undefined || tag === undefined || payload === undefined) {
    throw new Error("credential vault: sealed value is not in the expected format");
  }

  const decipher = createDecipheriv("aes-256-gcm", requireKey(key), Buffer.from(iv, "base64"), {
    authTagLength: 16,
  });
  decipher.setAAD(aad(tenantId, ref));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  // Throws on a bad tag, which is what a ciphertext moved between tenants produces.
  const opened = Buffer.concat([decipher.update(Buffer.from(payload, "base64")), decipher.final()]).toString("utf8");

  const material: unknown = JSON.parse(opened);
  if (!isMaterial(material)) throw new Error("credential vault: sealed value is not a credential");
  return material;
};

export interface CredentialVault {
  /** Null when the tenant has no credential under that name. Throws when it will not open. */
  resolve(tenantId: TenantId, ref: CredentialRef): Promise<Credential | null>;
}

export interface VaultOptions {
  /** 32 bytes. Held by the process, never by a tenant, never in the database. */
  readonly key: Buffer;
  /** Where the sealed values live. The vault never learns what storage they came from. */
  load(tenantId: TenantId, ref: CredentialRef): Promise<string | null>;
}

export const createCredentialVault = (options: VaultOptions): CredentialVault => {
  const key = requireKey(options.key);
  return {
    async resolve(tenantId, ref) {
      const sealed = await options.load(tenantId, ref);
      if (sealed === null) return null;
      return opaque(openCredential(key, tenantId, ref, sealed));
    },
  };
};

/**
 * The vault backed by values already in hand — the shape the call path uses, because the
 * tenant's configuration is loaded once and cached rather than read per tool call.
 *
 * Keyed by tenant as well as ref: a flat map would let a lookup miss on tenant A silently
 * find tenant B's key of the same name, and every tenant calls theirs `api_key`.
 */
export const createInMemoryVault = (
  key: Buffer,
  sealedByTenant: ReadonlyMap<TenantId, ReadonlyMap<CredentialRef, string>>,
): CredentialVault =>
  createCredentialVault({
    key,
    load: async (tenantId, ref) => sealedByTenant.get(tenantId)?.get(ref) ?? null,
  });
