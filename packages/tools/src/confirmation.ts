import { randomUUID } from "node:crypto";

import type { CallId, TenantId } from "@ansa/shared";

import type { ToolArgs } from "./types";

/**
 * Stable text for a set of arguments, independent of key order.
 *
 * The attack this closes is small and obvious once seen: read back a five thousand naira
 * transfer, get a yes, then present the same confirmation id with a different amount.
 * The id alone proves the caller said yes to *something*; the fingerprint proves what.
 */
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
};

export const fingerprintArgs = (args: ToolArgs): string => canonical(args);

/** Everything a confirmation is bound to. All four must match for the write to fire. */
export interface ConfirmationSubject {
  readonly tenantId: TenantId;
  readonly callId: CallId;
  readonly name: string;
  readonly fingerprint: string;
}

export type RedeemResult = "ok" | "stale" | "mismatch";

export interface ConfirmationStore {
  /** Returns the id to speak back with. */
  issue(subject: ConfirmationSubject, now: number): string;
  /** Single use: a yes fires one write, not every subsequent attempt at the same one. */
  redeem(id: string, subject: ConfirmationSubject, now: number): RedeemResult;
}

interface Pending {
  readonly subject: ConfirmationSubject;
  readonly expiresAt: number;
}

export const createConfirmationStore = (ttlMs: number): ConfirmationStore => {
  const pending = new Map<string, Pending>();

  return {
    issue(subject, now) {
      const id = randomUUID();
      pending.set(id, { subject, expiresAt: now + ttlMs });
      return id;
    },

    redeem(id, subject, now) {
      const held = pending.get(id);
      if (held === undefined || held.expiresAt <= now) {
        pending.delete(id);
        return "stale";
      }

      const s = held.subject;
      // Cross-call and cross-tenant reuse are mismatches, not staleness: the id is live,
      // it just does not belong to this conversation.
      if (s.tenantId !== subject.tenantId || s.callId !== subject.callId || s.name !== subject.name) {
        return "mismatch";
      }
      if (s.fingerprint !== subject.fingerprint) return "mismatch";

      pending.delete(id);
      return "ok";
    },
  };
};
