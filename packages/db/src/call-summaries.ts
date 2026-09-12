import type { OrganizationId } from "@ansa/shared";

import type { Db } from "./data-source";
import type { OrganizationScope } from "./organization-scope";

/**
 * What a call came to, and finding the calls that do not have one yet (migration 0079).
 *
 * Written by a sweeper rather than by the call path. Summarising is a model round trip and the
 * call path's one rule is that nothing waits on it; a sweeper is also retryable, which matters
 * because transcripts are flushed asynchronously and a summary written at hang-up would
 * describe whatever had happened to land by then.
 */
/* `WrittenSummary`, not `CallSummary`: `call-log.ts` has meant the latter since the viewer
   was built — a row of the call *list*, one line per call. Two different things called the
   same name in one package is how somebody imports the wrong one and the types happen to
   line up. */
export interface WrittenSummary {
  readonly summary: string;
  /** One entry per sentence: the transcript ids it rests on. */
  readonly cites: readonly (readonly string[])[];
  /** Null when the deterministic reducer wrote this because the model was unavailable. */
  readonly model: string | null;
  readonly createdAt: Date;
}

/**
 * Calls that have ended, have words, and have no summary.
 *
 * Unscoped, like `startDueCampaigns` and for the same reason: a sweeper holds no organisation.
 * And, like it, unscoped *through a definer function* — a raw select as `ansa_app` with no
 * organisation is not unscoped, it is empty. It returns the organisation with each call so the
 * write happens inside that organisation's own scope rather than under a second unscoped
 * statement.
 *
 * The settling delay is what stops this describing half a call. The recorder batches
 * transcripts every five seconds, so a call summarised the instant it hung up would be missing
 * its last exchange — usually the one that says how it turned out.
 */
export const readCallsNeedingSummary = async (
  dataSource: Db,
  settledForSeconds: number,
  limit: number,
): Promise<readonly { readonly callId: string; readonly organizationId: OrganizationId }[]> => {
  /* Through a `security definer` function (0081), not a plain select. The plain select was
     the bug: as `ansa_app` with no organisation set, RLS answered it with zero rows — not an
     error, not an empty table, just nothing — and the sweeper found "nothing to do" every
     minute for as long as it had existed. `start_due_campaigns` is the same shape for the
     same reason. */
  const rows = (await dataSource.query(
    "select call_id, organization_id from app.calls_needing_summary($1, $2)",
    [settledForSeconds, limit],
  )) as Record<string, unknown>[];

  return rows.map((row) => ({
    callId: String(row["call_id"]),
    organizationId: String(row["organization_id"]) as OrganizationId,
  }));
};

/** One line of the conversation, as the summariser needs it. */
export interface SummarisableLine {
  readonly id: string;
  readonly speaker: "caller" | "agent";
  readonly text: string;
}

/**
 * The lines to summarise, in the order they were said.
 *
 * A human's correction wins where there is one: a reviewer who fixed "a barn" to "Ibadan" has
 * said what was actually said, and summarising the mishearing instead would put the error into
 * prose somebody reads without the confidence score beside it.
 */
export const readSummarisableLines = async (
  scope: OrganizationScope,
  callId: string,
): Promise<readonly SummarisableLine[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select id, speaker, coalesce(corrected_text, text) as text
       from transcripts
      where call_id = $1 and kind = 'final'
      order by offset_ms, id`,
    [callId],
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    speaker: row["speaker"] === "agent" ? "agent" : "caller",
    text: String(row["text"]),
  }));
};

/**
 * Store it, once.
 *
 * `on conflict do nothing` rather than an upsert: a call is summarised once, and a second
 * sweeper finding the same row must lose quietly. Regenerating would mean two colleagues
 * reading different accounts of one call, which is what 0079 exists to prevent.
 */
export const saveCallSummary = async (
  scope: OrganizationScope,
  callId: string,
  written: {
    readonly summary: string;
    readonly cites: unknown;
    readonly model: string | null;
    readonly promptVersion: number;
  },
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `insert into call_summaries (call_id, organization_id, summary, cites, model, prompt_version)
     values ($1, app.current_organization(), $2, $3::jsonb, $4, $5)
     on conflict (call_id) do nothing
     returning call_id`,
    [callId, written.summary, JSON.stringify(written.cites), written.model, written.promptVersion],
  );
  return rows.length > 0;
};

/** The summary for one call, or null when it has none. */
export const readCallSummary = async (
  scope: OrganizationScope,
  callId: string,
): Promise<WrittenSummary | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    "select summary, cites, model, created_at from call_summaries where call_id = $1",
    [callId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    summary: String(row["summary"]),
    cites: Array.isArray(row["cites"])
      ? (row["cites"] as unknown[]).map((one) => (Array.isArray(one) ? one.map(String) : []))
      : [],
    model: row["model"] === null ? null : String(row["model"]),
    createdAt: new Date(String(row["created_at"])),
  };
};
