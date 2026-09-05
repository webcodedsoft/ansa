import {
  createCampaign,
  enqueueScheduledCalls,
  findAgent,
  readCampaign,
  readCampaigns,
  readScheduledCalls,
  setCampaignStatus,
  updateCampaign,
  type CampaignStatus,
  type CampaignSummary,
  type ScheduledCall,
  type ScheduledCallStatus,
} from "@ansa/db";
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import {
  pageQuery,
  pageResponse,
  toPageBody,
  toPageRequest,
  type PageQuery,
} from "../http/pagination";
import { ValidationFailed } from "../http/problem";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import {
  choice,
  integer,
  list,
  nullable,
  object,
  optional,
  text,
  type FieldError,
  type Infer,
} from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

/**
 * Outbound campaigns: a list of people to ring, and the record of ringing them (0061).
 *
 * Nothing here dials. A campaign is a queue and a state; a scheduler in a later wave drains
 * it, and between reading a row and dialling it that scheduler puts the number through
 * `mayCall` — do-not-call, consent, the calling window. That gate lives in the dispatch path
 * and not here, because there must be exactly one of it and a organisation must not be able
 * to configure it away.
 *
 * `campaigns:read` and `campaigns:write` rather than a reuse of `contacts:*` or `config:*`.
 * See `auth/capability.ts` for why: deciding to call a list is a larger and different grant
 * than correcting a contact or authoring an agent.
 */

/** Kept in step with the db's `CampaignStatus` by the `satisfies` below. */
const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "running",
  "paused",
  "done",
] as const satisfies readonly CampaignStatus[];

const SCHEDULED_STATUSES = [
  "pending",
  "placing",
  "answered",
  "no_answer",
  "busy",
  "voicemail",
  "failed",
  "suppressed",
] as const satisfies readonly ScheduledCallStatus[];

/**
 * Which state a campaign may move to from where it is.
 *
 * The happy path is draft → scheduled → running → paused → done, and a few sideways moves
 * that are genuinely useful: a scheduled campaign can be pulled back to draft, and a paused
 * one can be resumed or ended. A finished campaign is terminal — resuming it would place
 * calls against a list somebody considered closed — and every move not named here is refused
 * with a 409 that says which one it was. Same-state is a no-op and is allowed, so an
 * idempotent client does not have to special-case it.
 */
const LEGAL_TRANSITIONS: Readonly<Record<CampaignStatus, readonly CampaignStatus[]>> = {
  draft: ["scheduled"],
  scheduled: ["running", "draft"],
  running: ["paused", "done"],
  paused: ["running", "done"],
  done: [],
};

/**
 * When calling is allowed, as this organisation narrows it.
 *
 * Hours are WAT, 24-hour, `startHour` inclusive and `endHour` exclusive. `weekdays` names
 * the days calling may happen, 0 for Sunday through 6 for Saturday.
 *
 * **It can only narrow.** `mayCall` clamps every window to 08:00–20:00 WAT and no
 * configuration widens that — a window of 06:00–22:00 is honoured as 08:00–20:00, because
 * widening it is a choice about someone else's evening rather than this organisation's own
 * customers. The scheduler maps `startHour`/`endHour` onto `mayCall`'s hour bounds and gates
 * the day on `weekdays`; this endpoint only records the intent.
 */
const callingWindow = object({
  startHour: integer({ minimum: 0, maximum: 23 }),
  endHour: integer({ minimum: 1, maximum: 24 }),
  weekdays: list(integer({ minimum: 0, maximum: 6 }), { maxItems: 7 }),
});

const campaign = object({
  id: uuid(),
  agentId: uuid(),
  name: text({ maxLength: 200 }),
  status: choice(CAMPAIGN_STATUSES),
  /** Null is the default window `mayCall` applies anyway. */
  callingWindow: nullable(callingWindow),
  createdBy: nullable(uuid()),
  createdAt: timestamp(),
  updatedAt: timestamp(),
  /** Everyone enqueued, whatever became of them. */
  total: integer({ minimum: 0 }),
  /** Still waiting to be dialled. */
  pending: integer({ minimum: 0 }),
  /** Reached a person. */
  answered: integer({ minimum: 0 }),
});

const scheduledCall = object({
  id: uuid(),
  campaignId: uuid(),
  contactId: uuid(),
  phone: text({ maxLength: 32 }),
  displayName: nullable(text({ maxLength: 200 })),
  status: choice(SCHEDULED_STATUSES),
  /** How many times it has been taken for dialling. */
  attempts: integer({ minimum: 0 }),
  nextAttemptAt: nullable(timestamp()),
  lastAttemptAt: nullable(timestamp()),
  /** The reason behind the status, when there is one worth stating. */
  outcome: nullable(text({ maxLength: 256 })),
  /** The `calls` row, once the carrier made one. */
  callId: nullable(uuid()),
  createdAt: timestamp(),
  updatedAt: timestamp(),
});

const createBody = object({
  name: text({ minLength: 1, maxLength: 200 }),
  agentId: uuid(),
  callingWindow: optional(callingWindow),
});

const editBody = object({
  name: optional(text({ minLength: 1, maxLength: 200 })),
  /** Null clears the window back to the default; an omitted one is left alone. */
  callingWindow: optional(nullable(callingWindow)),
});

const statusBody = object({ status: choice(CAMPAIGN_STATUSES) });

/**
 * The largest set of contacts one enqueue request may carry.
 *
 * A ceiling, not a target: a bigger list is more requests, and the counts make that legible.
 */
const MAX_ENQUEUE = 5000;

const enqueueBody = object({ contactIds: list(uuid(), { maxItems: MAX_ENQUEUE }) });

const enqueueResult = object({
  /** How many ids were sent. */
  requested: integer({ minimum: 0 }),
  /** How many became a new scheduled call. Lower when an id was already on the campaign, or
   * belonged to another organisation and so matched nothing. */
  enqueued: integer({ minimum: 0 }),
});

const campaignPath = object({ campaignId: uuid() });

const campaignsPage = pageResponse(campaign);
const callsPage = pageResponse(scheduledCall);

/**
 * A stored window is jsonb, so its fields arrive untyped. Rebuilt field by field rather than
 * handed across as-is, which both satisfies the response schema and quietly tolerates a row
 * whose shape predates this one.
 */
const asCallingWindow = (
  stored: Record<string, unknown> | null,
): Infer<typeof callingWindow> | null => {
  if (stored === null) return null;
  const weekdays = Array.isArray(stored["weekdays"]) ? stored["weekdays"].map(Number) : [];
  return { startHour: Number(stored["startHour"]), endHour: Number(stored["endHour"]), weekdays };
};

const asCampaignBody = (summary: CampaignSummary): Infer<typeof campaign> => ({
  id: summary.id,
  agentId: summary.agentId,
  name: summary.name,
  status: summary.status,
  callingWindow: asCallingWindow(summary.callingWindow),
  createdBy: summary.createdBy,
  createdAt: summary.createdAt.toISOString(),
  updatedAt: summary.updatedAt.toISOString(),
  total: summary.total,
  pending: summary.pending,
  answered: summary.answered,
});

const asScheduledBody = (row: ScheduledCall): Infer<typeof scheduledCall> => ({
  id: row.id,
  campaignId: row.campaignId,
  contactId: row.contactId,
  phone: row.phone,
  displayName: row.displayName,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
  lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
  outcome: row.outcome,
  callId: row.callId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** The window rules the schema DSL cannot carry: a real span, and no repeated day. */
const windowProblems = (window: Infer<typeof callingWindow>): FieldError[] => {
  const problems: FieldError[] = [];
  if (window.endHour <= window.startHour) {
    problems.push({ path: "callingWindow.endHour", message: "must be after the start hour" });
  }
  if (window.weekdays.length === 0) {
    problems.push({ path: "callingWindow.weekdays", message: "name at least one weekday" });
  }
  if (new Set(window.weekdays).size !== window.weekdays.length) {
    problems.push({ path: "callingWindow.weekdays", message: "must not repeat a weekday" });
  }
  return problems;
};

@Controller(apiRoute("campaigns"))
export class CampaignsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "The organisation's outbound campaigns, newest first",
    description:
      "Each row carries where it has got to — total enqueued, still pending, and answered — counted from the scheduled calls under it.",
    capability: "campaigns:read",
    query: pageQuery,
    response: campaignsPage,
  })
  async list(@FromQuery() query: PageQuery): Promise<Infer<typeof campaignsPage>> {
    const slice = await this.db.tx((scope) => readCampaigns(scope, toPageRequest(query)));
    return toPageBody({ items: slice.items.map(asCampaignBody), total: slice.total }, query);
  }

  @Post()
  @Endpoint({
    summary: "Start a campaign",
    description:
      "Begins as a draft with nobody on it. The agent must be one this organisation runs; naming an agent it does not own is a 422 on `agentId`. An optional calling window narrows the hours and days — it can only narrow the 08:00–20:00 WAT bound `mayCall` already clamps to.",
    capability: "campaigns:write",
    body: createBody,
    response: campaign,
    status: 201,
  })
  async create(@FromBody() body: Infer<typeof createBody>): Promise<Infer<typeof campaign>> {
    if (body.callingWindow !== undefined) {
      const problems = windowProblems(body.callingWindow);
      if (problems.length > 0) throw new ValidationFailed(problems);
    }

    const created = await this.db.tx(async (scope) => {
      // Checked here rather than left to the foreign key, because an FK check runs as the
      // table owner and does not see RLS — so it would happily attach another organisation's
      // agent. This is the guard CLAUDE.md's outbound note asks for.
      const agent = await findAgent(scope, body.agentId);
      if (agent === null) return null;
      return createCampaign(scope, {
        agentId: body.agentId,
        name: body.name,
        callingWindow: body.callingWindow ?? null,
        createdBy: this.db.caller.userId,
      });
    });
    if (created === null) {
      throw new ValidationFailed([
        { path: "agentId", message: "no agent with this id in this organisation" },
      ]);
    }
    return asCampaignBody(created);
  }

  @Get(":campaignId")
  @Endpoint({
    summary: "One campaign, with its progress counts",
    capability: "campaigns:read",
    params: campaignPath,
    response: campaign,
  })
  async detail(@FromPath() path: Infer<typeof campaignPath>): Promise<Infer<typeof campaign>> {
    const found = await this.db.tx((scope) => readCampaign(scope, path.campaignId));
    // Not ours, which under RLS is also what another organisation's campaign looks like.
    if (found === null) throw new NotFoundException();
    return asCampaignBody(found);
  }

  @Patch(":campaignId")
  @Endpoint({
    summary: "Rename a campaign, or change its calling window",
    description:
      "Send `name`, `callingWindow`, or both. An omitted field is left as it was; a null `callingWindow` clears it back to the default window. The window can only narrow the 08:00–20:00 WAT bound `mayCall` clamps to.",
    capability: "campaigns:write",
    params: campaignPath,
    body: editBody,
    response: campaign,
  })
  async edit(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromBody() body: Infer<typeof editBody>,
  ): Promise<Infer<typeof campaign>> {
    if (body.callingWindow !== undefined && body.callingWindow !== null) {
      const problems = windowProblems(body.callingWindow);
      if (problems.length > 0) throw new ValidationFailed(problems);
    }

    const updated = await this.db.tx(async (scope) => {
      const changed = await updateCampaign(scope, path.campaignId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.callingWindow === undefined ? {} : { callingWindow: body.callingWindow }),
      });
      if (!changed) return null;
      return readCampaign(scope, path.campaignId);
    });
    if (updated === null) throw new NotFoundException();
    return asCampaignBody(updated);
  }

  @Post(":campaignId/status")
  @Endpoint({
    summary: "Move a campaign between states",
    description:
      "draft → scheduled → running → paused → done, plus scheduled → draft and paused → running. A finished campaign is terminal. An illegal move is refused with a 409 that names it; setting the state it is already in is a no-op.",
    capability: "campaigns:write",
    params: campaignPath,
    body: statusBody,
    response: campaign,
  })
  async setStatus(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromBody() body: Infer<typeof statusBody>,
  ): Promise<Infer<typeof campaign>> {
    const outcome = await this.db.tx(async (scope) => {
      const current = await readCampaign(scope, path.campaignId);
      if (current === null) return { kind: "missing" as const };
      const from = current.status;
      const to = body.status;
      if (from !== to && !LEGAL_TRANSITIONS[from].includes(to)) {
        return { kind: "illegal" as const, from, to };
      }
      if (from !== to) await setCampaignStatus(scope, path.campaignId, to);
      const after = await readCampaign(scope, path.campaignId);
      return { kind: "ok" as const, campaign: after };
    });

    if (outcome.kind === "missing") throw new NotFoundException();
    if (outcome.kind === "illegal") {
      throw new ConflictException(`a ${outcome.from} campaign cannot move to ${outcome.to}`);
    }
    // Read back inside the same transaction; a null here would mean it was deleted mid-flight.
    if (outcome.campaign === null) throw new NotFoundException();
    return asCampaignBody(outcome.campaign);
  }

  @Post(":campaignId/contacts")
  @Endpoint({
    summary: "Put contacts on a campaign",
    description:
      "Enqueues each contact as a pending call, due immediately — the scheduler still checks consent and the calling window before it dials. A contact already on the campaign, or an id from another organisation, is skipped; `enqueued` counts how many actually became a new call.",
    capability: "campaigns:write",
    params: campaignPath,
    body: enqueueBody,
    response: enqueueResult,
  })
  async enqueue(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromBody() body: Infer<typeof enqueueBody>,
  ): Promise<Infer<typeof enqueueResult>> {
    const outcome = await this.db.tx(async (scope) => {
      // So a non-existent (or another organisation's) campaign is a 404 rather than a silent
      // zero. `enqueueScheduledCalls` reads the organisation from the campaign row, so a
      // cross-organisation contact id attaches to nothing on its own.
      const found = await readCampaign(scope, path.campaignId);
      if (found === null) return null;
      /* A finished campaign takes no more people. `readDueScheduledCalls` only returns rows
         under a `running` campaign, so a row added to a `done` one is a call that will never
         be placed — and the list would then show "200 pending" beside a status the console
         describes as "nothing more will be dialled". Refused rather than silently accepted. */
      if (found.status === "done") return { closed: true as const };
      const enqueued = await enqueueScheduledCalls(
        scope,
        path.campaignId,
        body.contactIds,
        new Date(),
      );
      return { enqueued };
    });
    if (outcome === null) throw new NotFoundException();
    if ("closed" in outcome) {
      throw new ConflictException("this campaign is finished, so nothing more can be added to it");
    }
    return { requested: body.contactIds.length, enqueued: outcome.enqueued };
  }

  @Get(":campaignId/calls")
  @Endpoint({
    summary: "The calls scheduled under a campaign",
    description: "One row per enqueued contact, with the person beside it and where the call got to.",
    capability: "campaigns:read",
    params: campaignPath,
    query: pageQuery,
    response: callsPage,
  })
  async calls(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromQuery() query: PageQuery,
  ): Promise<Infer<typeof callsPage>> {
    const found = await this.db.tx(async (scope) => {
      const campaignRow = await readCampaign(scope, path.campaignId);
      if (campaignRow === null) return null;
      return readScheduledCalls(scope, path.campaignId, toPageRequest(query));
    });
    if (found === null) throw new NotFoundException();
    return toPageBody({ items: found.items.map(asScheduledBody), total: found.total }, query);
  }
}
