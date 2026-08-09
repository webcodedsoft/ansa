import {
  keysetOrder,
  keysetParams,
  keysetWhere,
  toSlice,
  type PageRequest,
  type PageSlice,
} from "./paging";
import type { TenantScope } from "./tenant-scope";

/**
 * Call history for the dashboard.
 *
 * Deliberately not `listCalls` from `call-log.ts`. That one takes `(Db, tenantId, limit)`
 * and opens its own transaction, which is right for the internal viewer, where the tenant
 * arrives as a query parameter and there is no session to infer it from. The dashboard's
 * tenant comes from the credential and its request already holds a scope, so this takes
 * the scope and paginates. Same table, two callers with genuinely different inputs.
 */

export interface CallPageItem {
  readonly id: string;
  readonly direction: string;
  readonly dialled: string;
  readonly caller: string | null;
  readonly answeredAt: string | null;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly createdAt: string;
}

interface CallPageRow {
  readonly id: string;
  readonly direction: string;
  readonly dialled: string;
  readonly caller: string | null;
  readonly answered_at: Date | null;
  readonly ended_at: Date | null;
  readonly end_reason: string | null;
  readonly duration_seconds: number | string | null;
  readonly created_at: Date;
}

export const listCallPage = async (
  scope: TenantScope,
  page: PageRequest,
): Promise<PageSlice<CallPageItem>> => {
  const rows = await scope.query<CallPageRow>(
    `select id, direction, dialled, caller, answered_at, ended_at, end_reason,
            duration_seconds, created_at
       from calls
      where ${keysetWhere("created_at", "id")}
      ${keysetOrder("created_at", "id")}`,
    keysetParams(page),
  );

  const calls = rows.map(
    (row): CallPageItem => ({
      id: row.id,
      direction: row.direction,
      dialled: row.dialled,
      caller: row.caller,
      answeredAt: row.answered_at?.toISOString() ?? null,
      endedAt: row.ended_at?.toISOString() ?? null,
      endReason: row.end_reason,
      durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
      createdAt: row.created_at.toISOString(),
    }),
  );
  return toSlice(calls, page, (call) => ({ createdAt: call.createdAt, id: call.id }));
};
