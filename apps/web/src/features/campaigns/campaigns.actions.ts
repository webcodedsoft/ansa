"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failureMessage, refusedWith } from "@/lib/api/server";
import { listContacts } from "@/features/contacts/contacts.service";
import { flowFromTemplate } from "@/features/agents/flow.schema";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { campaignTemplateById } from "./campaign-templates";
import {
  callingWindowSchema,
  createCampaignSchema,
  enqueueSchema,
  paceSchema,
  runAgainSchema,
  seriesStateSchema,
  setStatusSchema,
  type CreateCampaignInput,
  campaignBriefSchema,
} from "./campaigns.schema";
import {
  createCampaign,
  duplicateCampaign,
  editCampaign,
  editSeries,
  runAgain,
  enqueueContacts,
  retryUnreached,
  setCampaignStatus,
  type CampaignStatus,
  saveBrief,
  saveCampaignFlow,
} from "./campaigns.service";

/**
 * Server Actions for outbound campaigns.
 *
 * Each parses with its schema, sends through the service, and revalidates the paths that read
 * what it changed. Nothing here enforces consent, the calling window or agent ownership — the
 * API does, and this surfaces its refusal on the field or form it belongs to.
 */

/**
 * Read the calling window out of the create form, or nothing.
 *
 * The window is one checkbox and three groups of controls. When the checkbox is off the whole
 * object is absent, which is how the API is told "no window, use the default 08:00–20:00
 * bound". Building an empty object instead would submit a window that fails validation for
 * saying nothing.
 */
const windowFromForm = (form: FormData): CreateCampaignInput["callingWindow"] | undefined => {
  if (form.get("windowEnabled") !== "on") return undefined;
  return {
    startHour: Number(form.get("startHour")),
    endHour: Number(form.get("endHour")),
    weekdays: form.getAll("weekdays").map((day) => Number(day)),
  };
};

export interface CampaignCreated {
  readonly id: string;
}

export type CreateCampaignState = FormState<CampaignCreated>;

/**
 * Start a campaign, then open it.
 *
 * A new campaign is a draft with nobody on it, so the useful next screen is its detail page —
 * where contacts are added and the status is moved. The redirect lands there rather than back
 * on the list, and sits outside the try because `redirect` throws by design.
 */
export const createCampaignAction = async (
  _previous: CreateCampaignState,
  form: FormData,
): Promise<CreateCampaignState> => {
  const parsed = createCampaignSchema.safeParse({
    name: form.get("name") ?? "",
    agentId: form.get("agentId") ?? "",
    callingWindow: windowFromForm(form),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  /* A template is applied after the create rather than folded into it. Creation takes a
     name, an agent and a window; everything a template carries — the brief, the retry policy,
     the conversation — is what the brief endpoint already saves, and one route that does both
     would be a second copy of the brief's rules. Two calls behind one button. */
  const template = campaignTemplateById(String(form.get("templateId") ?? ""));

  let campaignId: string;
  try {
    const created = await createCampaign({
      ...parsed.data,
      /* The template's window unless the form set one. The form's choice wins because it is
         the later, more specific decision — somebody who picked a template and then narrowed
         the hours meant the hours. */
      ...(parsed.data.callingWindow === undefined && template?.callingWindow
        ? { callingWindow: template.callingWindow }
        : {}),
    });
    campaignId = created.id;

    if (template !== null) {
      await saveBrief(campaignId, {
        purpose: template.purpose,
        opening: template.opening,
        outcomes: [...template.outcomes],
        voicemail: { mode: template.voicemail },
        maxAttempts: template.maxAttempts,
        retryAfterMinutes: template.retryAfterMinutes,
      });
      if (template.conversation !== null) {
        await saveCampaignFlow(campaignId, flowFromTemplate(template.conversation));
      }
    }
  } catch (error) {
    return failedForm(failureMessage(error));
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaignId}`);
};

export interface Enqueued {
  readonly requested: number;
  readonly enqueued: number;
}

export type EnqueueState = FormState<Enqueued>;

/**
 * Put the chosen contacts on the campaign.
 *
 * `enqueued` counts the ones that became a new pending call. It can be less than `requested`:
 * a contact already on the campaign, or an id from another organisation, is skipped. The
 * caller reports both figures so a partial result reads as one rather than as a failure.
 */
export const enqueueContactsAction = async (
  _previous: EnqueueState,
  form: FormData,
): Promise<EnqueueState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  const parsed = enqueueSchema.safeParse({
    contactIds: form.getAll("contactIds").map(String),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await enqueueContacts(campaignId, parsed.data.contactIds);
    revalidatePath(`/campaigns/${campaignId}`);
    const skipped = result.requested - result.enqueued;
    return succeededForm(
      { requested: result.requested, enqueued: result.enqueued },
      skipped === 0
        ? `Enqueued ${result.enqueued} contact${result.enqueued === 1 ? "" : "s"}.`
        : `Enqueued ${result.enqueued} of ${result.requested}. ${skipped} skipped — already on this campaign, or not this organisation's.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export interface StatusMoved {
  readonly status: CampaignStatus;
}

export type SetStatusState = FormState<StatusMoved>;

/**
 * Move a campaign between states.
 *
 * The console offers only the legal moves, but the campaign can change under two people at
 * once, so an illegal move is still possible and the API refuses it with a 409 that names it.
 * `failureMessage` renders that sentence, which is more use than any message this could write.
 */
export const setStatusAction = async (
  _previous: SetStatusState,
  form: FormData,
): Promise<SetStatusState> => {
  const parsed = setStatusSchema.safeParse({
    campaignId: form.get("campaignId") ?? "",
    status: form.get("status") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    /* The reason rides only on a pause. The API ignores it otherwise, but sending it on a
       resume would be sending text that means nothing, so it is dropped here. */
    const rawReason = form.get("reason");
    const reason =
      parsed.data.status === "paused" && typeof rawReason === "string" && rawReason.trim() !== ""
        ? rawReason.trim()
        : null;
    const result = await setCampaignStatus(parsed.data.campaignId, parsed.data.status, reason);
    revalidatePath(`/campaigns/${parsed.data.campaignId}`);
    revalidatePath("/campaigns");
    return succeededForm({ status: result.status }, `Campaign is now ${result.status}.`);
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export interface PickerMatch {
  readonly id: string;
  readonly displayName: string | null;
  readonly phone: string;
}

export type ContactSearch =
  | { readonly ok: true; readonly contacts: readonly PickerMatch[] }
  | { readonly ok: false; readonly message: string };

/**
 * Find contacts to put on a campaign.
 *
 * The picker used to be handed one page of 100 and filter it in the browser, which quietly
 * made the import feature useless: `readContacts` orders by the most recent call and an
 * imported contact has never called, so every one of them sorts behind everybody who has.
 * An organisation with a hundred past callers could import five hundred people and find not
 * one of them in the picker — the import reported success and then dead-ended.
 *
 * Searching the server instead means the directory is reachable whatever its size and
 * whatever a contact's call history. Failure is reported as a message rather than thrown, so
 * a picker whose search fails shows "no matches" instead of taking the dialog down.
 */
export const findCampaignContacts = async (search: string): Promise<ContactSearch> => {
  try {
    const { page } = await listContacts(search === "" ? undefined : search, { perPage: 50 });
    return {
      ok: true,
      contacts: page.items.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        phone: person.phone,
      })),
    };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

const stringOrUndefined = (raw: FormDataEntryValue | null): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
};

const numberOrNaN = (raw: FormDataEntryValue | null): number =>
  raw === null || raw === "" ? Number.NaN : Number(raw);

export type BriefState = FormState<{ readonly campaignId: string }>;

/**
 * Save what a campaign is about.
 *
 * The 409 is the one worth naming. It means somebody started the campaign while this form was
 * open, and the brief is fixed from that moment — not out of caution but because a call may
 * already be in flight, and a person hearing "your viewing on Tuesday" must not have had the
 * reason changed under them. The message says that rather than "conflict".
 */
export const saveBriefAction = async (
  _previous: BriefState,
  form: FormData,
): Promise<BriefState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");

  const parsed = campaignBriefSchema.safeParse({
    purpose: stringOrUndefined(form.get("purpose")),
    opening: stringOrUndefined(form.get("opening")),
    outcomes: String(form.get("outcomes") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
    voicemailMode: String(form.get("voicemailMode") ?? "hang_up"),
    maxAttempts: numberOrNaN(form.get("maxAttempts")),
    retryAfterMinutes: numberOrNaN(form.get("retryAfterMinutes")),
  });
  if (!parsed.success) return invalidForm(parsed.error);

  const brief = parsed.data;
  try {
    await saveBrief(campaignId, {
      purpose: brief.purpose === undefined || brief.purpose === "" ? null : brief.purpose,
      opening: brief.opening === undefined || brief.opening === "" ? null : brief.opening,
      outcomes: brief.outcomes === undefined || brief.outcomes.length === 0 ? null : brief.outcomes,
      voicemail: { mode: brief.voicemailMode },
      maxAttempts: brief.maxAttempts,
      retryAfterMinutes: brief.retryAfterMinutes,
    });
    revalidatePath(`/campaigns/${campaignId}`);
    return succeededForm({ campaignId }, "Saved.");
  } catch (error) {
    if (refusedWith(error, 409)) {
      revalidatePath(`/campaigns/${campaignId}`);
      return failedForm(
        "This campaign has started, so what it says can no longer be changed — a call may already be in flight. Pause is not enough; make a new campaign to say something different.",
      );
    }
    return failedForm(failureMessage(error));
  }
};

/** The conversation, saved from the canvas on its own. */
export const saveCampaignFlowAction = async (
  _previous: BriefState,
  form: FormData,
): Promise<BriefState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");

  let flow: unknown;
  try {
    flow = JSON.parse(String(form.get("flow") ?? "null"));
  } catch {
    return failedForm("The drawing could not be read. Reload the page and try again.");
  }

  try {
    await saveCampaignFlow(campaignId, flow);
    revalidatePath(`/campaigns/${campaignId}`);
    return succeededForm({ campaignId }, "Conversation saved.");
  } catch (error) {
    if (refusedWith(error, 409)) {
      return failedForm("This campaign has started, so its conversation can no longer be changed.");
    }
    return failedForm(failureMessage(error));
  }
};

/**
 * Give the numbers that did not connect another go.
 *
 * Returns the count so the notice can say "12 back in the queue" rather than "done", and
 * revalidates the campaign page because the breakdown, the filter chips and the feed all
 * change under it.
 */
export type RetryState = FormState<{ readonly reset: number }>;

export const retryUnreachedAction = async (
  _previous: RetryState,
  form: FormData,
): Promise<RetryState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");
  try {
    const result = await retryUnreached(campaignId);
    revalidatePath(`/campaigns/${campaignId}`);
    return succeededForm({ reset: result.reset });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * When a campaign starts itself.
 *
 * An absent `startsAt` clears it rather than leaving it alone, because the form only omits
 * the field when somebody pressed "start by hand instead". That is the opposite of the PATCH
 * endpoint's own convention, where omitted means unchanged — so this sends an explicit null
 * rather than letting the omission travel and mean nothing.
 */
export type ScheduleState = FormState<{
  readonly startsAt: string | null;
  readonly endsAt: string | null;
}>;

export const setScheduleAction = async (
  _previous: ScheduleState,
  form: FormData,
): Promise<ScheduleState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");

  const instant = (key: string): string | null => {
    const raw = form.get(key);
    return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
  };
  const startsAt = instant("startsAt");
  const endsAt = instant("endsAt");
  for (const at of [startsAt, endsAt]) {
    if (at !== null && Number.isNaN(new Date(at).getTime())) {
      return failedForm("That is not a time this can understand.");
    }
  }

  try {
    /* Both ends every time, so clearing one is expressible. The endpoint treats an omitted
       field as unchanged, and this form's only way to say "no end" is to leave it empty. */
    await editCampaign(campaignId, { startsAt, endsAt });
    /* Both trees: the campaign's own page shows the time, and the list shows the status it
       will move to. One write, two screens. */
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/campaigns");
    return succeededForm({ startsAt, endsAt });
  } catch (error) {
    if (refusedWith(error, 422)) {
      /* Two different 422s share this path: a start on a campaign already running, and an end
         at or before the start. The API's own wording says which, so it is passed through
         rather than replaced with a guess. */
      return failedForm(failureMessage(error));
    }
    return failedForm(failureMessage(error));
  }
};

/**
 * Change the hours a campaign may ring, from its own page.
 *
 * Reads the same fields the create form posts (`windowFromForm`), so the two screens cannot
 * disagree about what a window is. "Default hours" arrives as no window at all and is sent as
 * an explicit null — the endpoint treats an omitted field as unchanged, and this form's only
 * way to say "back to the default bound" is to choose it.
 *
 * Allowed while the campaign is running, on purpose: "stop ringing after five" is an ordinary
 * thing to decide about a campaign already dialling, and the dialler reads the window on every
 * sweep, so it bites on the next one. The API holds it to the 08:00–20:00 WAT bound whatever
 * is sent.
 */
export type CallingWindowState = FormState<{
  readonly callingWindow: CreateCampaignInput["callingWindow"] | null;
}>;

export const setCallingWindowAction = async (
  _previous: CallingWindowState,
  form: FormData,
): Promise<CallingWindowState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");

  const raw = windowFromForm(form);
  const parsed = raw === undefined ? null : callingWindowSchema.safeParse(raw);
  if (parsed !== null && !parsed.success) {
    return invalidForm(parsed.error, "Check the hours and days.");
  }
  const callingWindow = parsed === null ? null : parsed.data;

  try {
    await editCampaign(campaignId, { callingWindow });
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/campaigns");
    return succeededForm({ callingWindow });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Change how fast a campaign dials, from its own page.
 *
 * Both caps are sent every time, so clearing one is expressible: the endpoint treats an
 * omitted field as unchanged, and this form's only way to say "no cap" is an empty box, which
 * the schema turns into null. Settable while running — "slow this down" is the most likely
 * moment anybody reaches for it — and the dialler reads the caps on every sweep.
 */
export type PaceState = FormState<{
  readonly maxConcurrentCalls: number | null;
  readonly maxCallsPerHour: number | null;
}>;

export const setPaceAction = async (_previous: PaceState, form: FormData): Promise<PaceState> => {
  const parsed = paceSchema.safeParse({
    campaignId: form.get("campaignId"),
    maxConcurrentCalls: form.get("maxConcurrentCalls"),
    maxCallsPerHour: form.get("maxCallsPerHour"),
  });
  if (!parsed.success) return invalidForm(parsed.error, "Check the numbers.");
  const { campaignId, maxConcurrentCalls, maxCallsPerHour } = parsed.data;

  try {
    await editCampaign(campaignId, { maxConcurrentCalls, maxCallsPerHour });
    revalidatePath(`/campaigns/${campaignId}`);
    return succeededForm({ maxConcurrentCalls, maxCallsPerHour });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Run a campaign again on a rhythm, and change the series afterwards.
 *
 * The rhythm and the run length are choices from the shared vocabulary, never free text; the
 * first run's start comes from the same presets the schedule card offers. The API refuses a
 * template without a purpose and a second series on one template, and its wording says which.
 */
export type SeriesState = FormState<{ readonly state: string; readonly nextRunAt: string }>;

export const runAgainAction = async (_previous: SeriesState, form: FormData): Promise<SeriesState> => {
  const parsed = runAgainSchema.safeParse({
    campaignId: form.get("campaignId"),
    every: form.get("every"),
    runFor: form.get("runFor"),
    anchorAt: form.get("anchorAt"),
  });
  if (!parsed.success) return invalidForm(parsed.error, "Choose a rhythm and a first run.");
  const { campaignId, ...body } = parsed.data;
  try {
    const series = await runAgain(campaignId, body);
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath("/campaigns");
    return succeededForm({ state: series.state, nextRunAt: series.nextRunAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export const setSeriesStateAction = async (_previous: SeriesState, form: FormData): Promise<SeriesState> => {
  const parsed = seriesStateSchema.safeParse({ campaignId: form.get("campaignId"), state: form.get("state") });
  if (!parsed.success) return invalidForm(parsed.error);
  try {
    const series = await editSeries(parsed.data.campaignId, { state: parsed.data.state });
    revalidatePath(`/campaigns/${parsed.data.campaignId}`);
    revalidatePath("/campaigns");
    return succeededForm({ state: series.state, nextRunAt: series.nextRunAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Copy a campaign's words onto a fresh draft and open it.
 *
 * The redirect is the point: a duplicate you are not taken to is one you have to go and find,
 * and the next thing anybody does with a copy is add the people it should ring. Outside the
 * try, because `redirect` throws by design.
 */
export type DuplicateState = FormState<{ readonly campaignId: string }>;

export const duplicateCampaignAction = async (
  _previous: DuplicateState,
  form: FormData,
): Promise<DuplicateState> => {
  const campaignId = String(form.get("campaignId") ?? "");
  if (campaignId === "") return failedForm("This form does not say which campaign it is for.");

  const raw = form.get("name");
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name === "") return failedForm("Give the copy a name.");

  let created: string;
  try {
    created = (await duplicateCampaign(campaignId, name)).id;
  } catch (error) {
    return failedForm(failureMessage(error));
  }

  revalidatePath("/campaigns");
  redirect(`/campaigns/${created}`);
};
