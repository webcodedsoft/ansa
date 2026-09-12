import { api } from "@/lib/api/server";

const DEFAULT_PAGE_SIZE = 25;

export type AuditKind = "people" | "agents" | "calls" | "organisation" | "security";

export const AUDIT_KINDS: readonly AuditKind[] = ["people", "agents", "calls", "organisation", "security"];

/** The log, newest first. `kind` narrows to one bucket; null is everything. */
export const listAudit = async (page: number, perPage = DEFAULT_PAGE_SIZE, kind: AuditKind | null = null) =>
  (await api()).audit.list({ query: { page, perPage, ...(kind === null ? {} : { kind }) } });

export type AuditPage = Awaited<ReturnType<typeof listAudit>>;
export type AuditEntry = AuditPage["items"][number];
