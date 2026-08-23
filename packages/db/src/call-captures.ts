import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import { withOrganization } from "./organization-scope";
import type { OrganizationScope } from "./organization-scope";

/**
 * The values a caller actually gave, read and written as data.
 *
 * `agents.captured_fields` is the form: what the agent asks, in what order. This is the
 * answers. They were previously nowhere — recoverable only by matching a `value confirmed`
 * character count back to an `entity_candidate` of the same length, which the handoff
 * summary does because a person reading a live summary can absorb being one readback
 * stale. An organisation's record of their own data cannot.
 *
 * Written at confirmation, so the field is known rather than inferred.
 */

export interface CallCapture {
  readonly fieldKey: string;
  readonly fieldType: string;
  readonly value: string;
  readonly attempts: number;
  readonly confirmedAt: Date;
}

/** One call's answers, with enough of the call attached to make a row of a table. */
export interface CapturedRow extends CallCapture {
  readonly callId: string;
  readonly carrierCallId: string;
  readonly caller: string | null;
  readonly agentId: string | null;
  readonly calledAt: Date;
}

export interface RecordCaptureInput {
  readonly fieldKey: string;
  readonly fieldType: string;
  readonly value: string;
  readonly attempts: number;
}

/**
 * Store one confirmed value.
 *
 * Upserts on the field. A caller who corrects their number has one number, and the second
 * reading is the right one — the first is still in `call_events` for anyone asking how the
 * conversation went, which is a different question from what they told us.
 *
 * `organization_id` comes from the scope rather than the caller, so a call id from another
 * organisation writes a row RLS then refuses rather than a row filed under the wrong
 * organisation.
 */
export const recordCapture = async (
  scope: OrganizationScope,
  input: RecordCaptureInput & { readonly callId: string },
): Promise<void> => {
  await scope.query(
    `insert into call_captures
       (organization_id, call_id, field_key, field_type, value, attempts, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (call_id, field_key) do update
       set value = excluded.value,
           field_type = excluded.field_type,
           attempts = excluded.attempts,
           confirmed_at = excluded.confirmed_at`,
    [
      scope.organizationId,
      input.callId,
      input.fieldKey,
      input.fieldType,
      input.value,
      Math.max(1, Math.trunc(input.attempts)),
    ],
  );
};

/** Everything collected on one call, in the order the agent asked for it. */
export const readCallCaptures = async (
  scope: OrganizationScope,
  callId: string,
): Promise<readonly CallCapture[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select field_key, field_type, value, attempts, confirmed_at
       from call_captures
      where call_id = $1
      order by confirmed_at, id`,
    [callId],
  );
  return rows.map((row) => ({
    fieldKey: String(row["field_key"]),
    fieldType: String(row["field_type"]),
    value: String(row["value"]),
    attempts: Number(row["attempts"]),
    confirmedAt: new Date(String(row["confirmed_at"])),
  }));
};

export interface CaptureQuery {
  readonly agentId?: string | null;
  readonly since?: Date | null;
  readonly until?: Date | null;
  readonly limit?: number;
}

/**
 * Everything collected across calls, for the dataset view and its export.
 *
 * Returns one row per value rather than per call. The console pivots it into a column per
 * field, which cannot be done here: two agents have different forms, and a fixed column
 * list would be wrong for whichever one it was not built from.
 *
 * The ceiling is deliberate and reported rather than silent — see `readCapturedRows`'s
 * caller, which tells the operator when a page was cut short.
 */
export const readCapturedRows = async (
  scope: OrganizationScope,
  query: CaptureQuery = {},
): Promise<readonly CapturedRow[]> => {
  const limit = Math.min(Math.max(1, Math.trunc(query.limit ?? 1_000)), 10_000);
  const rows = await scope.query<Record<string, unknown>>(
    `select cc.field_key, cc.field_type, cc.value, cc.attempts, cc.confirmed_at,
            c.id as call_id, c.carrier_call_id, c.caller, c.agent_id, c.created_at
       from call_captures cc
       join calls c on c.id = cc.call_id
      where ($1::uuid is null or c.agent_id = $1::uuid)
        and ($2::timestamptz is null or cc.confirmed_at >= $2::timestamptz)
        and ($3::timestamptz is null or cc.confirmed_at < $3::timestamptz)
      order by c.created_at desc, cc.confirmed_at, cc.id
      limit $4`,
    [query.agentId ?? null, query.since ?? null, query.until ?? null, limit],
  );
  return rows.map((row) => ({
    callId: String(row["call_id"]),
    carrierCallId: String(row["carrier_call_id"]),
    caller: row["caller"] === null ? null : String(row["caller"]),
    agentId: row["agent_id"] === null ? null : String(row["agent_id"]),
    calledAt: new Date(String(row["created_at"])),
    fieldKey: String(row["field_key"]),
    fieldType: String(row["field_type"]),
    value: String(row["value"]),
    attempts: Number(row["attempts"]),
    confirmedAt: new Date(String(row["confirmed_at"])),
  }));
};

/**
 * Write a batch of confirmed values, from the call recorder's flush.
 *
 * Batched and fire-and-forget for the same reason every other call-path write is: the
 * conversation cannot wait on Postgres, and CLAUDE.md is explicit that nothing puts a
 * database round trip on the real-time path. A dropped batch is logged by the recorder
 * and the value is still in `call_events` as the `entity_candidate` it came from, so the
 * failure costs the dataset a row and costs the call nothing.
 *
 * `on conflict do update` rather than `do nothing`: a caller correcting their number
 * within one flush window must end up with the corrected one, and the batch is ordered.
 */
export const recordCaptures = async (
  dataSource: Db,
  organizationId: OrganizationId,
  callRowId: string,
  captures: readonly RecordCaptureInput[],
): Promise<void> => {
  if (captures.length === 0) return;
  await withOrganization(dataSource, organizationId, async (scope) => {
    const values: unknown[] = [];
    const tuples = captures.map((c, i) => {
      const b = i * 6;
      values.push(
        organizationId,
        callRowId,
        c.fieldKey,
        c.fieldType,
        c.value,
        Math.max(1, Math.trunc(c.attempts)),
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    await scope.query(
      `insert into call_captures
         (organization_id, call_id, field_key, field_type, value, attempts)
       values ${tuples.join(", ")}
       on conflict (call_id, field_key) do update
         set value = excluded.value,
             field_type = excluded.field_type,
             attempts = excluded.attempts,
             confirmed_at = now()`,
      values,
    );
  });
};
