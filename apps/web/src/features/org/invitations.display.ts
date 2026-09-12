import type { Tone } from "@/components/ui";

import type { InvitationSummary } from "./org.service";

/**
 * Where an invitation stands, in one word and one colour.
 *
 * Revoked outranks accepted outranks expired: an invitation accepted and then revoked is
 * revoked, and an expired one nobody accepted is expired rather than pending. Pending is the
 * only state anything can still be done to.
 */
export type InvitationStatus = "pending" | "accepted" | "expired" | "revoked";

export const statusOf = (invitation: InvitationSummary, now = Date.now()): InvitationStatus => {
  if (invitation.revokedAt !== null) return "revoked";
  if (invitation.acceptedAt !== null) return "accepted";
  if (new Date(invitation.expiresAt).getTime() < now) return "expired";
  return "pending";
};

export const STATUS_TONE: Readonly<Record<InvitationStatus, Tone>> = {
  pending: "accent",
  accepted: "ok",
  expired: "warn",
  revoked: "neutral",
};

/**
 * How long an invitation has left, in the words a person uses.
 *
 * "Expires in 6 days" is the answer to "do I need to chase them"; a date is a subtraction
 * the reader has to do. Under a day it says so rather than "0 days", which reads as already
 * gone.
 */
export const expiry = (expiresAt: string, now = Date.now()): string => {
  const ms = new Date(expiresAt).getTime() - now;
  const days = Math.floor(Math.abs(ms) / 86_400_000);
  if (ms < 0) return days === 0 ? "expired today" : `expired ${days} ${days === 1 ? "day" : "days"} ago`;
  if (days === 0) return "expires today";
  return `expires in ${days} ${days === 1 ? "day" : "days"}`;
};

/** Pending first, then by newest — the ones something can still be done to lead. */
export const pendingFirst = (
  invitations: readonly InvitationSummary[],
  now = Date.now(),
): readonly InvitationSummary[] =>
  [...invitations].sort((a, b) => {
    const pa = statusOf(a, now) === "pending" ? 0 : 1;
    const pb = statusOf(b, now) === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
  });

/** Two letters for a person's circle: from a name when there is one, else the email. */
export const initials = (displayName: string | null, email: string): string => {
  const name = (displayName ?? "").trim();
  if (name !== "") {
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
    return `${first}${second}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
};
