import {
  createCampaign,
  enqueueScheduledCalls,
  findAgent,
  readCampaign,
  duplicateCampaign,
  readCampaignBreakdown,
  readRecentCalls,
  retryUnreached,
  readCampaigns,
  readScheduledCalls,
  setCampaignStatus,
  updateCampaign,
  updateCampaignBrief,
  type CampaignStatus,
  type CampaignSummary,
  type ScheduledCall,
  type ScheduledCallStatus,
} from "@ansa/db";
import {
  CAMPAIGN_LIMITS,
  VOICEMAIL_MODES,
  briefIsEditable,
  validateFlow,
  type Flow,
} from "@ansa/shared";
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Patch,
  Post,
  UnprocessableEntityException,
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
  flag,
  integer,
  map,
  list,
  nullable,
  object,
  optional,
  text,
  type FieldError,
  type Infer,
} from "../http/schema";
import { asFlow, flow, flowProblems } from "../agents/flow.schema";
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

/**
 * What to do when a machine answers.
 *
 * `hang_up` is the default because a message left by mistake cannot be taken back, and
 * CLAUDE.md is plain that an agent holding a conversation with a greeting is both useless and
 * billed. A message is read verbatim rather than improvised: a model talking to a beep has no
 * one to correct it.
 */
const voicemail = object({ mode: choice(VOICEMAIL_MODES) });

const asVoicemail = (raw: Record<string, unknown> | null): Infer<typeof voicemail> | null => {
  if (raw === null) return null;
  const mode = String(raw["mode"]);
  if (mode !== "hang_up" && mode !== "leave_message") return null;
  return { mode };
};

/**
 * What may be written to a campaign's brief.
 *
 * Every field optional: a brief is written over several sittings and half of one should save.
 * What is *not* optional is that a running campaign has a purpose — checked when it starts
 * rather than when it is typed, so the refusal lands at the moment it means something.
 */
const campaignBrief = object({
  purpose: optional(nullable(text({ maxLength: CAMPAIGN_LIMITS.purposeLength }))),
  opening: optional(nullable(text({ maxLength: CAMPAIGN_LIMITS.openingLength }))),
  flow: optional(nullable(flow)),
  outcomes: optional(
    nullable(
      list(text({ minLength: 1, maxLength: CAMPAIGN_LIMITS.outcomeLength }), {
        maxItems: CAMPAIGN_LIMITS.outcomes,
      }),
    ),
  ),
  voicemail: optional(nullable(voicemail)),
  maxAttempts: optional(
    integer({ minimum: CAMPAIGN_LIMITS.attempts.min, maximum: CAMPAIGN_LIMITS.attempts.max }),
  ),
  retryAfterMinutes: optional(
    integer({
      minimum: CAMPAIGN_LIMITS.retryMinutes.min,
      maximum: CAMPAIGN_LIMITS.retryMinutes.max,
    }),
  ),
});

const campaign = object({
  id: uuid(),
  agentId: uuid(),
  name: text({ maxLength: 200 }),
  status: choice(CAMPAIGN_STATUSES),
  /** Null is the default window `mayCall` applies anyway. */
  callingWindow: nullable(callingWindow),
  /** Why this campaign rings. The agent says it in the opening; null means it has nothing to say. */
  purpose: nullable(text({ maxLength: CAMPAIGN_LIMITS.purposeLength })),
  /** The exact first line, or null to let the agent compose one from the purpose. */
  opening: nullable(text({ maxLength: CAMPAIGN_LIMITS.openingLength })),
  /** The conversation as a graph. Null means there is no script beyond the purpose. */
  flow: nullable(flow),
  /** What counts as done, as names the agent picks from at the end. */
  outcomes: nullable(list(text({ maxLength: CAMPAIGN_LIMITS.outcomeLength }))),
  voicemail: nullable(voicemail),
  maxAttempts: integer({ minimum: CAMPAIGN_LIMITS.attempts.min, maximum: CAMPAIGN_LIMITS.attempts.max }),
  retryAfterMinutes: integer({
    minimum: CAMPAIGN_LIMITS.retryMinutes.min,
    maximum: CAMPAIGN_LIMITS.retryMinutes.max,
  }),
  /** Whether the brief may still be changed. False once calls can be in flight. */
  briefEditable: flag(),
  /**
   * When it starts dialling by itself, or null to start it by hand.
   *
   * Only meaningful while it is waiting. A campaign already running keeps the time it was
   * scheduled for as a record of when it began.
   */
  startsAt: nullable(timestamp()),
  /**
   * When it stops dialling, whatever is left on the list. Null runs to exhaustion.
   *
   * Stays settable for the whole life of a campaign, which `startsAt` does not: shortening a
   * run already under way is the ordinary case.
   */
  endsAt: nullable(timestamp()),
  /** Why it is paused, in the operator's words. Null unless it is paused and somebody said. */
  pauseReason: nullable(text({ maxLength: CAMPAIGN_LIMITS.pauseReasonLength })),
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
  /** Null clears the start time back to starting by hand; an omitted one is left alone. */
  startsAt: optional(nullable(timestamp())),
  /** Null clears the end back to running until the list is exhausted. */
  endsAt: optional(nullable(timestamp())),
});

const duplicateBody = object({ name: text({ minLength: 1, maxLength: 200 }) });

/** The page query, plus the one status somebody wants to look at. */
const callsQuery = object({
  page: optional(integer({ minimum: 1 })),
  perPage: optional(integer({ minimum: 1 })),
  status: optional(choice(SCHEDULED_STATUSES)),
});

/** Enough to answer "is it working right now"; the paged list is for everything else. */
const RECENT_LIMIT = 10;

const recent = object({ items: list(scheduledCall) });

const retried = object({ reset: integer({ minimum: 0 }) });

/* A record rather than a fixed shape. A status or verdict nothing reached is absent, which
   is not the same as zero — "nobody was suppressed" and "suppression was never possible on
   this campaign" read differently, and the caller decides which to draw. */
const breakdown = object({
  byStatus: map(integer({ minimum: 0 })),
  byOutcome: map(integer({ minimum: 0 }), { maxProperties: CAMPAIGN_LIMITS.outcomes }),
});

/** Distinguishable from `null`, which already means "no such campaign" on this path. */
const ALREADY_STARTED = Symbol("already started");

/** Also distinguishable from `null`, and from the refusal above. */
const ENDS_TOO_SOON = Symbol("ends before it starts");

const statusBody = object({
  status: choice(CAMPAIGN_STATUSES),
  /** Read only on a move to `paused`; one line on why, for whoever opens it tomorrow. */
  reason: optional(nullable(text({ maxLength: CAMPAIGN_LIMITS.pauseReasonLength }))),
});

/**
 * The largest set of contacts one enqueue request may carry.
 *
 * A ceiling, not a target: a bigger list is more requests, and the counts make that legible.
 */
const MAX_ENQUEUE = 5000;

/**
 * Who to ring, and what differs about each of them.
 *
 * `facts` is keyed by contact id rather than positional, so a caller cannot line the wrong
 * detail up against the wrong person — which is the failure that would put somebody else's
 * appointment in a stranger's ear. Anybody not named there simply has no facts, and the
 * campaign says only what it says to everyone.
 */
const enqueueBody = object({
  contactIds: list(uuid(), { maxItems: MAX_ENQUEUE }),
  facts: optional(
    map(
      map(text({ maxLength: CAMPAIGN_LIMITS.factValueLength }), {
        maxProperties: CAMPAIGN_LIMITS.facts,
      }),
      { maxProperties: MAX_ENQUEUE },
    ),
  ),
});

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
  purpose: summary.purpose,
  opening: summary.opening,
  flow: (summary.flow ?? null) as Infer<typeof flow> | null,
  outcomes: summary.outcomes === null ? null : [...summary.outcomes],
  voicemail: asVoicemail(summary.voicemail),
  maxAttempts: summary.maxAttempts,
  retryAfterMinutes: summary.retryAfterMinutes,
  briefEditable: briefIsEditable(summary.status),
  startsAt: summary.startsAt === null ? null : summary.startsAt.toISOString(),
  endsAt: summary.endsAt === null ? null : summary.endsAt.toISOString(),
  pauseReason: summary.pauseReason,
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
      "Send `name`, `callingWindow`, `startsAt`, `endsAt`, or any combination. An omitted field is left as it was; a null `callingWindow` clears it back to the default window and a null `startsAt` back to starting by hand. The window can only narrow the 08:00–20:00 WAT bound `mayCall` clamps to. A `startsAt` is refused with 422 once the campaign has left draft or scheduled, because a start time for a campaign that has already started is a value nothing would ever read; `endsAt` stays settable throughout, since shortening a run already under way is the ordinary case. An end at or before the start is refused with 422 — a run that finishes before it begins would start and stop on the same sweep and read as a campaign that silently did nothing.",
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
      /* Read before writing, only when a start time was sent. `updateCampaign` has no status
         guard of its own — renaming a running campaign is fine — so this is where a start
         time that could never fire is refused rather than stored and ignored. */
      /* Read first when either end was sent: one to refuse a start time that could never
         fire, and one to compare the two ends — which needs whichever of them is not in this
         request, since either may be arriving alone. */
      if (body.startsAt !== undefined || body.endsAt !== undefined) {
        const existing = await readCampaign(scope, path.campaignId);
        if (existing === null) return null;
        if (body.startsAt !== undefined && !briefIsEditable(existing.status)) return ALREADY_STARTED;

        const from =
          body.startsAt === undefined
            ? existing.startsAt
            : body.startsAt === null
              ? null
              : new Date(body.startsAt);
        const to =
          body.endsAt === undefined
            ? existing.endsAt
            : body.endsAt === null
              ? null
              : new Date(body.endsAt);
        if (from !== null && to !== null && to.getTime() <= from.getTime()) return ENDS_TOO_SOON;
      }

      const changed = await updateCampaign(scope, path.campaignId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.callingWindow === undefined ? {} : { callingWindow: body.callingWindow }),
        ...(body.startsAt === undefined
          ? {}
          : { startsAt: body.startsAt === null ? null : new Date(body.startsAt) }),
        ...(body.endsAt === undefined
          ? {}
          : { endsAt: body.endsAt === null ? null : new Date(body.endsAt) }),
      });
      if (!changed) return null;
      return readCampaign(scope, path.campaignId);
    });
    if (updated === ENDS_TOO_SOON) {
      throw new UnprocessableEntityException(
        "The end has to be after the start, or the campaign would stop on the same sweep it began.",
      );
    }
    if (updated === ALREADY_STARTED) {
      throw new UnprocessableEntityException(
        "This campaign has already started, so a start time would never be read.",
      );
    }
    if (updated === null) throw new NotFoundException();
    return asCampaignBody(updated);
  }

  @Patch(":campaignId/brief")
  @Endpoint({
    summary: "Say what this campaign is about",
    description:
      "The purpose, the opening, the conversation as a graph, what counts as done, whether to leave the standard message when a machine answers, and how many times one person may be rung. Absent fields are left alone; null clears one. Refused with 409 once the campaign is running, paused or done — a call in flight must not have its purpose changed underneath it. A flow is validated exactly as an agent's is.",
    capability: "campaigns:write",
    params: campaignPath,
    body: campaignBrief,
    response: campaign,
  })
  async setBrief(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromBody() body: Infer<typeof campaignBrief>,
  ): Promise<Infer<typeof campaign>> {
    /* The same validator an agent's flow goes through. A campaign that draws an unreachable
       step, or a branch with nothing to branch on, is the same defect wherever it was drawn
       and should be refused in the same words. */
    if (body.flow !== undefined && body.flow !== null) {
      const problems = flowProblems(body.flow);
      if (problems.length > 0) throw new ValidationFailed(problems);
    }
    const outcome = await this.db.tx(async (scope) => {
      const found = await readCampaign(scope, path.campaignId);
      if (found === null) return null;
      const saved = await updateCampaignBrief(scope, path.campaignId, {
        ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
        ...(body.opening === undefined ? {} : { opening: body.opening }),
        ...(body.flow === undefined
          ? {}
          : {
              flow:
                body.flow === null
                  ? null
                  : (asFlow(body.flow) as unknown as Record<string, unknown>),
            }),
        ...(body.outcomes === undefined ? {} : { outcomes: body.outcomes }),
        ...(body.voicemail === undefined
          ? {}
          : { voicemail: body.voicemail === null ? null : { ...body.voicemail } }),
        ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
        ...(body.retryAfterMinutes === undefined
          ? {}
          : { retryAfterMinutes: body.retryAfterMinutes }),
      });
      /* Null from the writer means the row exists but its status refused the write. The status
         is read again rather than trusted from the pre-check: between the two, somebody may
         have pressed Start. */
      return saved === null ? { frozen: found.status } : { saved };
    });

    if (outcome === null) throw new NotFoundException();
    if ("frozen" in outcome) {
      throw new ConflictException(
        `a ${outcome.frozen} campaign's brief cannot be changed, because calls may already be in flight`,
      );
    }
    return asCampaignBody(outcome.saved);
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
      /* A campaign that is about to dial must know why it is ringing.
       *
       * Checked here rather than when the brief is typed, because a half-written brief should
       * save — the refusal belongs at the moment it means something, which is the moment
       * somebody presses Start. `prompts/outbound.ts` requires the agent to open by saying why
       * it is calling; without a purpose the model would compose one, and an invented reason
       * for an unexpected call is exactly what a scam sounds like. */
      if (to === "running" && (current.purpose === null || current.purpose.trim() === "")) {
        return { kind: "aimless" as const };
      }
      /* And a script that holds together.
       *
       * Checked at Start rather than at save, which is where the agent path checks its own:
       * `publication.ts` runs `validateFlow` when a configuration is published and lets a
       * draft hold a half-drawn graph. A campaign has no publish, so Start is the moment —
       * a flow whose edge points at a step that does not exist is a call that stops mid
       * sentence, and there is no later gate to catch it. */
      if (to === "running" && current.flow !== null) {
        const blocking = validateFlow(current.flow as unknown as Flow).filter(
          (problem) => problem.blocking,
        );
        if (blocking.length > 0) {
          return { kind: "unsound" as const, why: blocking[0]?.message ?? "the flow is not valid" };
        }
      }
      if (from !== to) {
        const reason = body.reason === undefined || body.reason === null ? null : body.reason.trim();
        await setCampaignStatus(scope, path.campaignId, to, reason === "" ? null : reason);
      }
      const after = await readCampaign(scope, path.campaignId);
      return { kind: "ok" as const, campaign: after };
    });

    if (outcome.kind === "missing") throw new NotFoundException();
    if (outcome.kind === "illegal") {
      throw new ConflictException(`a ${outcome.from} campaign cannot move to ${outcome.to}`);
    }
    if (outcome.kind === "unsound") {
      throw new ConflictException(`this campaign's conversation cannot be run: ${outcome.why}`);
    }
    if (outcome.kind === "aimless") {
      throw new ConflictException(
        "this campaign has no purpose, so the agent would have nothing to say it was calling about — write one before starting it",
      );
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
        body.facts ?? {},
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
    description:
      "One row per enqueued contact, with the person beside it and where the call got to. Pass `status` to narrow it to one — the total narrows with it, so the pager counts what was asked for rather than everything.",
    capability: "campaigns:read",
    params: campaignPath,
    query: callsQuery,
    response: callsPage,
  })
  async calls(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromQuery() query: Infer<typeof callsQuery>,
  ): Promise<Infer<typeof callsPage>> {
    const found = await this.db.tx(async (scope) => {
      const campaignRow = await readCampaign(scope, path.campaignId);
      if (campaignRow === null) return null;
      return readScheduledCalls(scope, path.campaignId, toPageRequest(query), query.status);
    });
    if (found === null) throw new NotFoundException();
    return toPageBody({ items: found.items.map(asScheduledBody), total: found.total }, query);
  }

  @Get(":campaignId/recent")
  @Endpoint({
    summary: "The last few calls that happened",
    description:
      "The most recently attempted rows first — the call that just finished at the top. Rows never attempted are left out, because a pending row has not happened yet. Ten at most; the paged list is `calls`. This is the feed a running campaign's page polls.",
    capability: "campaigns:read",
    params: campaignPath,
    response: recent,
  })
  async recent(@FromPath() path: Infer<typeof campaignPath>): Promise<Infer<typeof recent>> {
    const found = await this.db.tx(async (scope) => {
      const campaignRow = await readCampaign(scope, path.campaignId);
      if (campaignRow === null) return null;
      return readRecentCalls(scope, path.campaignId, RECENT_LIMIT);
    });
    if (found === null) throw new NotFoundException();
    return { items: found.map(asScheduledBody) };
  }

  @Post(":campaignId/retry")
  @Endpoint({
    summary: "Try the calls that did not connect again",
    description:
      "Puts every `no_answer`, `busy` and `failed` row back to pending with its attempts reset, due now. Nothing else is touched: an answered call is done, a suppressed one was refused by the consent gate and would be refused again, and a pending one is already waiting. Returns how many were reset. The campaign still has to be running for them to dial.",
    capability: "campaigns:write",
    params: campaignPath,
    response: retried,
  })
  async retry(@FromPath() path: Infer<typeof campaignPath>): Promise<Infer<typeof retried>> {
    const found = await this.db.tx(async (scope) => {
      const campaignRow = await readCampaign(scope, path.campaignId);
      if (campaignRow === null) return null;
      return retryUnreached(scope, path.campaignId);
    });
    if (found === null) throw new NotFoundException();
    return { reset: found };
  }

  @Get(":campaignId/breakdown")
  @Endpoint({
    summary: "How a campaign turned out",
    description:
      "Two counts over the same rows. `byStatus` is what the dialler did — answered, rang out, engaged, refused by the consent gate. `byOutcome` is what the calls came to, from the campaign's own list of verdicts as the agent recorded them, and is the only one that says whether the campaign worked. A status or verdict nothing reached is absent rather than zero.",
    capability: "campaigns:read",
    params: campaignPath,
    response: breakdown,
  })
  async breakdown(
    @FromPath() path: Infer<typeof campaignPath>,
  ): Promise<Infer<typeof breakdown>> {
    const found = await this.db.tx(async (scope) => {
      const campaignRow = await readCampaign(scope, path.campaignId);
      if (campaignRow === null) return null;
      return readCampaignBreakdown(scope, path.campaignId);
    });
    if (found === null) throw new NotFoundException();
    return { byStatus: { ...found.byStatus }, byOutcome: { ...found.byOutcome } };
  }

  @Post(":campaignId/duplicate")
  @Endpoint({
    summary: "Copy a campaign's words onto a new draft",
    description:
      "Everything somebody wrote comes across — the brief, the flow, the outcomes, the voicemail choice, the retry settings and the window. Nothing the original did comes with it: no contacts, no calls, no start time, and the copy is a draft. Copying the list would be a button that silently re-rings everyone on it.",
    capability: "campaigns:write",
    params: campaignPath,
    body: duplicateBody,
    response: campaign,
    // A new campaign, like `POST /campaigns` beside it. Same act, same code.
    status: 201,
  })
  async duplicate(
    @FromPath() path: Infer<typeof campaignPath>,
    @FromBody() body: Infer<typeof duplicateBody>,
  ): Promise<Infer<typeof campaign>> {
    const created = await this.db.tx((scope) =>
      duplicateCampaign(scope, path.campaignId, {
        name: body.name,
        createdBy: this.db.caller.userId,
      }),
    );
    if (created === null) throw new NotFoundException();
    return asCampaignBody(created);
  }
}
