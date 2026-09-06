import {
  SERIES_EVERY,
  SERIES_RUN_FOR,
  seriesEveryFromText,
  seriesRunForFromText,
  type OrganizationId,
  type SeriesEvery,
  type SeriesRunFor,
} from "@ansa/shared";

import type { Db } from "./data-source";
import type { OrganizationScope } from "./organization-scope";

/**
 * A campaign that runs again on its own (migration 0074).
 *
 * A series is a rhythm and a template. Each run is an ordinary campaign, created by
 * `app.create_due_runs()` from the sweeper with its start and end set, and then started by
 * `start_due_campaigns` like any scheduled campaign. Nothing here is read by a call.
 */
export interface CampaignSeries {
  readonly id: string;
  readonly templateId: string;
  readonly name: string;
  readonly every: SeriesEvery;
  readonly runFor: SeriesRunFor;
  readonly anchorAt: Date;
  readonly nextRunAt: Date;
  readonly runsCreated: number;
  /** `paused` creates no more runs until resumed; `ended` never will. */
  readonly state: "active" | "paused" | "ended";
  readonly createdAt: Date;
}

const SERIES_COLUMNS = `
  cs.id, cs.template_id, cs.name, cs.every::text as every, cs.run_for::text as run_for,
  cs.anchor_at, cs.next_run_at, cs.runs_created, cs.paused_at, cs.ended_at, cs.created_at`;

const asSeries = (row: Record<string, unknown>): CampaignSeries => {
  /* An interval nothing in SERIES_EVERY made is a row written by hand; refusing to read it is
     the honest answer, because the console could not show or edit it. */
  const every = seriesEveryFromText(String(row["every"]));
  const runFor = seriesRunForFromText(String(row["run_for"]));
  if (every === null || runFor === null) {
    throw new Error(`campaign series ${String(row["id"])} has an interval the product did not write`);
  }
  return {
    id: String(row["id"]),
    templateId: String(row["template_id"]),
    name: String(row["name"]),
    every,
    runFor,
    anchorAt: new Date(String(row["anchor_at"])),
    nextRunAt: new Date(String(row["next_run_at"])),
    runsCreated: Number(row["runs_created"]),
    state: row["ended_at"] !== null ? "ended" : row["paused_at"] !== null ? "paused" : "active",
    createdAt: new Date(String(row["created_at"])),
  };
};

export interface NewSeries {
  readonly templateId: string;
  readonly name: string;
  readonly every: SeriesEvery;
  readonly runFor: SeriesRunFor;
  /** When the first run starts. Each next one is this plus n × every. */
  readonly anchorAt: Date;
  readonly createdBy: string | null;
}

/**
 * Turn a campaign into a series' template. One per template — the unique key refuses a
 * second, which the endpoint reports as a conflict rather than letting two rhythms ring
 * the same people.
 */
export const createSeries = async (
  scope: OrganizationScope,
  input: NewSeries,
): Promise<CampaignSeries | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `insert into campaign_series
       (organization_id, template_id, name, every, run_for, anchor_at, next_run_at, created_by)
     select app.current_organization(), cp.id, $2, $3::interval, $4::interval, $5, $5, $6
       from campaigns cp
      where cp.id = $1
     returning id`,
    [
      input.templateId,
      input.name,
      SERIES_EVERY[input.every].interval,
      SERIES_RUN_FOR[input.runFor].interval,
      input.anchorAt,
      input.createdBy,
    ],
  );
  const created = rows[0];
  if (created === undefined) return null;
  return readSeries(scope, String(created["id"]));
};

export const readSeries = async (
  scope: OrganizationScope,
  seriesId: string,
): Promise<CampaignSeries | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${SERIES_COLUMNS} from campaign_series cs where cs.id = $1`,
    [seriesId],
  );
  const row = rows[0];
  return row === undefined ? null : asSeries(row);
};

/**
 * The series a campaign belongs to: the one it is the template of, or the one that created
 * it as a run. Null for a one-off.
 */
export const readSeriesForCampaign = async (
  scope: OrganizationScope,
  campaignId: string,
): Promise<CampaignSeries | null> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select ${SERIES_COLUMNS}
       from campaign_series cs
      where cs.template_id = $1
         or cs.id = (select series_id from campaigns where id = $1)
      limit 1`,
    [campaignId],
  );
  const row = rows[0];
  return row === undefined ? null : asSeries(row);
};

export interface SeriesEdit {
  readonly name?: string;
  readonly every?: SeriesEvery;
  readonly runFor?: SeriesRunFor;
  /** `active` resumes a paused series. `ended` is final: an ended series does not resume. */
  readonly state?: "active" | "paused" | "ended";
}

/**
 * Change a series. Resuming moves `next_run_at` forward to the first future beat of the
 * rhythm rather than firing every run missed while paused: a series paused for three
 * months should not ring everyone three times on the morning it resumes.
 */
export const updateSeries = async (
  scope: OrganizationScope,
  seriesId: string,
  edit: SeriesEdit,
): Promise<boolean> => {
  const rows = await scope.mutate<Record<string, unknown>>(
    `update campaign_series
        set name    = coalesce($2, name),
            every   = coalesce($3::interval, every),
            run_for = coalesce($4::interval, run_for),
            paused_at = case
                          when $5 = 'paused' then coalesce(paused_at, now())
                          when $5 = 'active' then null
                          else paused_at
                        end,
            ended_at = case when $5 = 'ended' then coalesce(ended_at, now()) else ended_at end,
            next_run_at = case
                            when $5 = 'active' and paused_at is not null and next_run_at < now()
                            then (
                              select anchor_at + coalesce($3::interval, every) * k
                                from generate_series(runs_created, runs_created + 400) as k
                               where anchor_at + coalesce($3::interval, every) * k > now()
                               order by k
                               limit 1
                            )
                            else next_run_at
                          end,
            updated_at = now()
      where id = $1
        and ended_at is null
      returning id`,
    [
      seriesId,
      edit.name ?? null,
      edit.every === undefined ? null : SERIES_EVERY[edit.every].interval,
      edit.runFor === undefined ? null : SERIES_RUN_FOR[edit.runFor].interval,
      edit.state ?? null,
    ],
  );
  return rows.length > 0;
};

export interface SeriesRun {
  readonly campaignId: string;
  readonly runNumber: number;
  readonly status: string;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly total: number;
  readonly answered: number;
}

/** The runs a series has created so far, newest first. Each is an ordinary campaign. */
export const readSeriesRuns = async (
  scope: OrganizationScope,
  seriesId: string,
): Promise<readonly SeriesRun[]> => {
  const rows = await scope.query<Record<string, unknown>>(
    `select cp.id, cp.run_number, cp.status, cp.starts_at, cp.ends_at,
            (select count(*) from scheduled_calls s where s.campaign_id = cp.id)::int as total,
            (select count(*) from scheduled_calls s
              where s.campaign_id = cp.id and s.status = 'answered')::int as answered
       from campaigns cp
      where cp.series_id = $1
      order by cp.run_number desc`,
    [seriesId],
  );
  return rows.map((row) => ({
    campaignId: String(row["id"]),
    runNumber: Number(row["run_number"]),
    status: String(row["status"]),
    startsAt: row["starts_at"] === null ? null : new Date(String(row["starts_at"])),
    endsAt: row["ends_at"] === null ? null : new Date(String(row["ends_at"])),
    total: Number(row["total"]),
    answered: Number(row["answered"]),
  }));
};

/**
 * Create every run that has come due. Unscoped, from the sweeper, through a security-definer
 * function like `start_due_campaigns`: the sweeper has no organisation in hand. Returns what
 * it made so the sweeper can log it; `start_due_campaigns` on the same tick then starts any
 * run whose moment is already here.
 */
export const createDueRuns = async (
  dataSource: Db,
): Promise<
  readonly {
    readonly campaignId: string;
    readonly seriesId: string;
    readonly organizationId: OrganizationId;
    readonly runNumber: number;
  }[]
> => {
  const rows = (await dataSource.query(
    "select out_campaign_id as campaign_id, out_series_id as series_id, out_organization_id as organization_id, out_run_number as run_number from app.create_due_runs()",
  )) as Record<string, unknown>[];
  return rows.map((row) => ({
    campaignId: String(row["campaign_id"]),
    seriesId: String(row["series_id"]),
    organizationId: String(row["organization_id"]) as OrganizationId,
    runNumber: Number(row["run_number"]),
  }));
};
