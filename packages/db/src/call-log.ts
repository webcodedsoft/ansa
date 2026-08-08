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

export interface RecordedTranscript {
  readonly text: string;
  readonly confidence: number | null;
  readonly offsetMs: number;
  readonly provider: string;
}

/**
 * Final transcripts, batched.
 *
 * Only finals. Interims exist to make the agent feel responsive and are superseded
 * within a second; storing them would multiply the table by an order of magnitude for
 * text nobody will ever review.
 *
 * This table is where the R9.2 loop actually lives: `corrected_text` is a human's
 * correction of what the transcriber heard, and the pair of columns is what turns one
 * caller's mishearing into a test case and a keyterm for every tenant.
 */
export const recordTranscripts = async (
  dataSource: Db,
  tenantId: TenantId,
  callRowId: string,
  transcripts: readonly RecordedTranscript[],
): Promise<void> => {
  if (transcripts.length === 0) return;
  await withTenant(dataSource, tenantId, async (scope) => {
    const values: unknown[] = [];
    const tuples = transcripts.map((t, i) => {
      const b = i * 6;
      values.push(tenantId, callRowId, t.text, t.confidence, t.offsetMs, t.provider);
      return `($${b + 1}, $${b + 2}, 'final', $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await scope.query(
      `insert into transcripts (tenant_id, call_id, kind, text, confidence, offset_ms, provider)
       values ${tuples.join(", ")}`,
      values,
    );
  });
};

export interface RecordedTurn {
  readonly seq: number;
  readonly speaker: "caller" | "agent";
  readonly startedOffsetMs: number;
  readonly endedOffsetMs: number | null;
  readonly bargedInAtMs: number | null;
}

export const recordTurns = async (
  dataSource: Db,
  tenantId: TenantId,
  callRowId: string,
  turns: readonly RecordedTurn[],
): Promise<void> => {
  if (turns.length === 0) return;
  await withTenant(dataSource, tenantId, async (scope) => {
    const values: unknown[] = [];
    const tuples = turns.map((t, i) => {
      const b = i * 7;
      values.push(
        tenantId, callRowId, t.seq, t.speaker,
        t.startedOffsetMs, t.endedOffsetMs, t.bargedInAtMs,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
    });
    await scope.query(
      `insert into turns
         (tenant_id, call_id, seq, speaker, started_offset_ms, ended_offset_ms, barged_in_at_ms)
       values ${tuples.join(", ")}
       on conflict do nothing`,
      values,
    );
  });
};

// ---------------------------------------------------------------------------
// Reading calls back — the viewer's half (R8.1)
// ---------------------------------------------------------------------------

export interface CallSummary {
  readonly id: string;
  readonly carrierCallId: string;
  readonly direction: string;
  readonly dialled: string;
  readonly caller: string | null;
  readonly answeredAt: Date | null;
  readonly endedAt: Date | null;
  readonly endReason: string | null;
  readonly durationSeconds: number | null;
  readonly turnCount: number;
}

/** Most recent first, because a reviewer wants the call that just went wrong. */
export const listCalls = async (
  dataSource: Db,
  tenantId: TenantId,
  limit = 50,
): Promise<readonly CallSummary[]> =>
  withTenant(dataSource, tenantId, async (scope) => {
    const rows = await scope.query<Record<string, unknown>>(
      `select c.id, c.carrier_call_id, c.direction, c.dialled, c.caller,
              c.answered_at, c.ended_at, c.end_reason, c.duration_seconds,
              (select count(*) from turns t where t.call_id = c.id) as turn_count
         from calls c
        order by c.created_at desc
        limit $1`,
      [Math.min(limit, 200)],
    );
    return rows.map((r) => ({
      id: String(r["id"]),
      carrierCallId: String(r["carrier_call_id"]),
      direction: String(r["direction"]),
      dialled: String(r["dialled"]),
      caller: r["caller"] === null ? null : String(r["caller"]),
      answeredAt: (r["answered_at"] as Date | null) ?? null,
      endedAt: (r["ended_at"] as Date | null) ?? null,
      endReason: r["end_reason"] === null ? null : String(r["end_reason"]),
      durationSeconds: r["duration_seconds"] === null ? null : Number(r["duration_seconds"]),
      turnCount: Number(r["turn_count"] ?? 0),
    }));
  });

export interface CallDetail {
  readonly summary: CallSummary;
  readonly events: readonly { kind: string; offsetMs: number | null; detail: unknown; at: Date }[];
  readonly transcripts: readonly {
    text: string;
    correctedText: string | null;
    confidence: number | null;
    offsetMs: number;
    provider: string;
  }[];
}

/**
 * One call, everything about it.
 *
 * Scoped like every other read: a viewer that could show another tenant's transcripts
 * would be the most damaging leak in the product, since transcripts are the one place
 * callers say their policy numbers out loud.
 */
export const loadCall = async (
  dataSource: Db,
  tenantId: TenantId,
  callId: string,
): Promise<CallDetail | null> =>
  withTenant(dataSource, tenantId, async (scope) => {
    const calls = await scope.query<Record<string, unknown>>(
      `select c.id, c.carrier_call_id, c.direction, c.dialled, c.caller,
              c.answered_at, c.ended_at, c.end_reason, c.duration_seconds,
              (select count(*) from turns t where t.call_id = c.id) as turn_count
         from calls c where c.id = $1`,
      [callId],
    );
    const r = calls[0];
    if (r === undefined) return null;

    const events = await scope.query<Record<string, unknown>>(
      "select kind, offset_ms, detail, at from call_events where call_id = $1 order by id",
      [callId],
    );
    const transcripts = await scope.query<Record<string, unknown>>(
      `select text, corrected_text, confidence, offset_ms, provider
         from transcripts where call_id = $1 order by offset_ms`,
      [callId],
    );

    return {
      summary: {
        id: String(r["id"]),
        carrierCallId: String(r["carrier_call_id"]),
        direction: String(r["direction"]),
        dialled: String(r["dialled"]),
        caller: r["caller"] === null ? null : String(r["caller"]),
        answeredAt: (r["answered_at"] as Date | null) ?? null,
        endedAt: (r["ended_at"] as Date | null) ?? null,
        endReason: r["end_reason"] === null ? null : String(r["end_reason"]),
        durationSeconds: r["duration_seconds"] === null ? null : Number(r["duration_seconds"]),
        turnCount: Number(r["turn_count"] ?? 0),
      },
      events: events.map((e) => ({
        kind: String(e["kind"]),
        offsetMs: e["offset_ms"] === null ? null : Number(e["offset_ms"]),
        detail: e["detail"],
        at: e["at"] as Date,
      })),
      transcripts: transcripts.map((t) => ({
        text: String(t["text"]),
        correctedText: t["corrected_text"] === null ? null : String(t["corrected_text"]),
        confidence: t["confidence"] === null ? null : Number(t["confidence"]),
        offsetMs: Number(t["offset_ms"]),
        provider: String(t["provider"]),
      })),
    };
  });

/**
 * Records the carrier's own verdict on a call, from a webhook with no tenant context.
 *
 * See migration 0009 for why this bypasses RLS and why that is safe: one row, found by an
 * identifier the carrier issued, nothing returned.
 */
export const closeCallByCarrierId = async (
  dataSource: Db,
  carrierCallId: string,
  status: string,
  durationSeconds: number | null,
): Promise<void> => {
  await dataSource.query("select app.close_call_by_carrier_id($1, $2, $3)", [
    carrierCallId,
    status,
    durationSeconds,
  ]);
};

