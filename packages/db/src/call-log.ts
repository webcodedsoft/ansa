import type { TenantId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withTenant } from "./tenant-scope";

/**
 * Writing calls down.
 *
 * Everything the agent does has been logged to stdout and stored nowhere, which makes the
 * R9.2 review loop impossible: a failure that only exists in a log file someone greps by
 * hand teaches the product nothing. This is the prerequisite for that loop, for the call
 * viewer, and for the R7.5 audit trail.
 *
 * One rule governs the whole module: **a write failing must never affect the call.** The
 * caller is mid-conversation and a database hiccup is not their problem. Every function
 * here is safe to call and forget; failures are reported through the logger and swallowed.
 */

export interface StartedCall {
  readonly tenantId: TenantId;
  readonly carrierCallId: string;
  readonly direction: "inbound" | "outbound";
  readonly dialled: string;
  readonly caller: string | null;
  readonly configVersion: number | null;
  /** Snapshotted for outbound, so a later policy change cannot rewrite this call. */
  readonly consentPolicy?: string | null;
  readonly consentBasis?: string | null;
}

/** Returns the row id, which everything else in the call hangs off. */
export const recordCallStarted = async (
  dataSource: Db,
  call: StartedCall,
): Promise<string | null> =>
  withTenant(dataSource, call.tenantId, async (scope) => {
    const rows = await scope.query<{ id: string }>(
      `insert into calls
         (tenant_id, carrier_call_id, direction, dialled, caller, config_version,
          consent_policy, consent_basis, answered_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       returning id`,
      [
        call.tenantId,
        call.carrierCallId,
        call.direction,
        call.dialled,
        call.caller,
        call.configVersion,
        call.consentPolicy ?? null,
        call.consentBasis ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  });

export interface CallEvent {
  readonly tenantId: TenantId;
  readonly callRowId: string;
  /** Short, stable, greppable. The same word the log line uses. */
  readonly kind: string;
  readonly offsetMs?: number | null;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export const recordCallEvent = async (dataSource: Db, event: CallEvent): Promise<void> => {
  await withTenant(dataSource, event.tenantId, async (scope) => {
    await scope.query(
      `insert into call_events (tenant_id, call_id, kind, offset_ms, detail)
       values ($1, $2, $3, $4, $5)`,
      [
        event.tenantId,
        event.callRowId,
        event.kind,
        event.offsetMs ?? null,
        JSON.stringify(event.detail ?? {}),
      ],
    );
  });
};

/** Batched, because a call produces far more events than it does round trips worth spending. */
export const recordCallEvents = async (
  dataSource: Db,
  tenantId: TenantId,
  callRowId: string,
  events: readonly { kind: string; offsetMs?: number | null; detail?: Readonly<Record<string, unknown>> }[],
): Promise<void> => {
  if (events.length === 0) return;
  await withTenant(dataSource, tenantId, async (scope) => {
    // One statement, one round trip. A call that produced two hundred events should not
    // cost two hundred transactions to Ohio.
    const values: unknown[] = [];
    const tuples = events.map((e, i) => {
      const base = i * 5;
      values.push(tenantId, callRowId, e.kind, e.offsetMs ?? null, JSON.stringify(e.detail ?? {}));
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await scope.query(
      `insert into call_events (tenant_id, call_id, kind, offset_ms, detail) values ${tuples.join(", ")}`,
      values,
    );
  });
};

export interface EndedCall {
  readonly tenantId: TenantId;
  readonly callRowId: string;
  readonly endReason: string;
  readonly carrierStatus?: string | null;
  readonly durationSeconds?: number | null;
}

export const recordCallEnded = async (dataSource: Db, call: EndedCall): Promise<void> => {
  await withTenant(dataSource, call.tenantId, async (scope) => {
    await scope.query(
      `update calls
          set ended_at = now(), end_reason = $2,
              carrier_status = coalesce($3, carrier_status),
              duration_seconds = coalesce($4, duration_seconds)
        where id = $1`,
      [call.callRowId, call.endReason, call.carrierStatus ?? null, call.durationSeconds ?? null],
    );
  });
};
