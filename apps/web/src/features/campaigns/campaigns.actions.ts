"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { failureMessage } from "@/lib/api/server";
import { listContacts } from "@/features/contacts/contacts.service";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import {
  createCampaignSchema,
  enqueueSchema,
  setStatusSchema,
  type CreateCampaignInput,
} from "./campaigns.schema";
import {
  createCampaign,
  enqueueContacts,
  setCampaignStatus,
  type CampaignStatus,
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

  let campaignId: string;
  try {
    const created = await createCampaign(parsed.data);
    campaignId = created.id;
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
    const result = await setCampaignStatus(parsed.data.campaignId, parsed.data.status);
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
