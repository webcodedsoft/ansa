import type { TenantId } from "@ansa/shared";

import type { ToolArgs } from "../types";
import type { InternalTool } from "./adapter";

/**
 * A worked internal tool set, standing in for a tenant's policy administration system.
 *
 * It exists so the dispatch path is exercised end to end by something shaped like a real
 * tool rather than by a stub: one tool per risk tier, arguments that arrive from a model
 * and therefore cannot be trusted, results that have to become a sentence, and a lookup
 * that is scoped by tenant because every lookup in this product is.
 *
 * The book is in memory. Replacing it with the tenant's HTTP connector is a change to
 * `PolicyBook` and nothing else.
 */
export interface PolicyRecord {
  readonly tenantId: TenantId;
  readonly policyNumber: string;
  readonly holder: string;
  readonly status: "active" | "lapsed" | "pending";
  /** Whole naira. Written as ₦ in speech and expanded by the normalizer downstream. */
  readonly premiumNaira: number;
  /** "12 September". Left as text the normalizer already knows how to say. */
  readonly renewsOn: string;
  readonly contactNumber: string;
}

export interface PolicyBook {
  find(tenantId: TenantId, policyNumber: string): Promise<PolicyRecord | null>;
  setContactNumber(
    tenantId: TenantId,
    policyNumber: string,
    contactNumber: string,
  ): Promise<PolicyRecord | null>;
}

const normaliseNumber = (raw: string): string => raw.replace(/[\s-]/g, "").toUpperCase();

export const createInMemoryPolicyBook = (seed: readonly PolicyRecord[]): PolicyBook => {
  // Keyed by tenant *and* number. A single flat map keyed by policy number would work
  // right up until two tenants issued the same one, which insurers reliably do.
  const key = (tenantId: TenantId, policyNumber: string): string =>
    `${tenantId}::${normaliseNumber(policyNumber)}`;

  const records = new Map<string, PolicyRecord>(
    seed.map((record) => [key(record.tenantId, record.policyNumber), record]),
  );

  return {
    async find(tenantId, policyNumber) {
      return records.get(key(tenantId, policyNumber)) ?? null;
    },
    async setContactNumber(tenantId, policyNumber, contactNumber) {
      const k = key(tenantId, policyNumber);
      const existing = records.get(k);
      if (existing === undefined) return null;
      const updated = { ...existing, contactNumber };
      records.set(k, updated);
      return updated;
    },
  };
};

/**
 * Arguments come from a language model, so they are input, not data. A bad one throws
 * and the dispatcher turns it into a spoken apology rather than a crash.
 */
const requireString = (args: ToolArgs, key: string): string => {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing or empty argument: ${key}`);
  }
  return value.trim();
};

const isPolicy = (value: unknown): value is PolicyRecord =>
  value !== null && typeof value === "object" && "policyNumber" in value;

const STATUS_WORDS: Readonly<Record<PolicyRecord["status"], string>> = {
  active: "active",
  lapsed: "lapsed",
  pending: "still being processed",
};

const sayPolicy = (record: PolicyRecord): string =>
  `Policy ${record.policyNumber} is in ${record.holder}'s name and it is ${STATUS_WORDS[record.status]}. ` +
  `The premium is ₦${record.premiumNaira.toLocaleString("en-NG")} and it renews on ${record.renewsOn}.`;

export const policyTools = (book: PolicyBook): readonly InternalTool[] => [
  {
    definition: {
      name: "policy_lookup",
      description: "Look up a policy by its number: holder, status, premium and renewal date.",
      parameters: {
        type: "object",
        properties: { policyNumber: { type: "string", description: "The policy number, as the caller gave it." } },
        required: ["policyNumber"],
      },
      riskTier: "read",
      summarise: (result) =>
        isPolicy(result)
          ? sayPolicy(result)
          : "I can't find a policy with that number on our records.",
    },
    handler: async ({ tenantId, args }) => book.find(tenantId, requireString(args, "policyNumber")),
  },

  {
    definition: {
      name: "update_contact_number",
      description: "Change the phone number held against a policy.",
      parameters: {
        type: "object",
        properties: {
          policyNumber: { type: "string" },
          contactNumber: { type: "string", description: "The new phone number, confirmed with the caller." },
        },
        required: ["policyNumber", "contactNumber"],
      },
      riskTier: "write",
      // R4.3.1. The caller hears their own values back before anything is written, and
      // there is no confidence score anywhere that skips this line.
      readback: (args) =>
        `Just to confirm — I'm changing the number on policy ${String(args.policyNumber)} to ` +
        `${String(args.contactNumber)}. Should I go ahead?`,
      summarise: (result) =>
        isPolicy(result)
          ? `Done — the number on policy ${result.policyNumber} is now ${result.contactNumber}.`
          : "I couldn't find that policy, so nothing has been changed.",
    },
    handler: async ({ tenantId, args }) =>
      book.setContactNumber(
        tenantId,
        requireString(args, "policyNumber"),
        requireString(args, "contactNumber"),
      ),
  },

  {
    definition: {
      name: "cancel_policy",
      description: "Cancel a policy outright.",
      parameters: { type: "object", properties: { policyNumber: { type: "string" } }, required: ["policyNumber"] },
      riskTier: "irreversible",
      transferReason: "policy cancellation",
    },
    // Never reached. Left as a tripwire rather than a no-op: if the dispatcher ever lets
    // an irreversible tool through, this is the line that says so instead of a policy
    // quietly ending.
    handler: async () => {
      throw new Error("cancel_policy must never execute — it is irreversible tier");
    },
  },
];
