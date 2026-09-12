"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, Notice, Stack } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { setCallingWindowAction, type CallingWindowState } from "../campaigns.actions";
import { windowSummary } from "../campaigns.display";
import type { CampaignWindow } from "../campaigns.service";
import { CallingWindowStrip } from "./calling-window-strip";
import {
  CallingWindowFields,
  WindowChoice,
  draftToWindow,
  windowToDraft,
  type WindowDraft,
} from "./calling-window-fields";

const START: CallingWindowState = idleForm();

/**
 * The hours a campaign may ring, on its own page, as a thing that can be changed.
 *
 * It was a drawing with a caption and no controls, so the only way to narrow a campaign's
 * hours after creating it was to make another campaign. The drawing stays — it is the best
 * description of a window there is — and now redraws as the controls beneath it change, so
 * what somebody is about to save is the shape they are looking at, not a sentence about it.
 *
 * The controls are the create form's own (`calling-window-fields`), so a window offered here
 * is exactly one that screen would have offered. Edit is a mode rather than always-on: the
 * card is read far more often than it is changed, and seven pills and two selects under
 * every strip would make the schedule tab a form.
 *
 * Saving is a form post under the field names `windowFromForm` reads. Choosing "default hours"
 * posts no window, and the action sends that as an explicit null so the API clears the column
 * rather than leaving it as it was.
 */
export const CampaignCallingWindow = ({
  campaignId,
  window: saved,
  canWrite,
}: {
  readonly campaignId: string;
  readonly window: CampaignWindow | null;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(setCallingWindowAction, START);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WindowDraft>(() => windowToDraft(saved));

  const shown = editing ? draftToWindow(draft) : saved;
  const empty = draft.mode === "custom" && (draft.days.size === 0 || draft.endHour <= draft.startHour);

  const begin = (): void => {
    setDraft(windowToDraft(saved));
    setEditing(true);
  };

  const cancel = (): void => {
    setDraft(windowToDraft(saved));
    setEditing(false);
  };

  const save = (form: FormData): void => {
    form.set("campaignId", campaignId);
    startTransition(() => {
      action(form);
      setEditing(false);
    });
  };

  return (
    <form action={save}>
      <Stack gap="sm">
        <CallingWindowStrip window={shown} />

        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "invalid" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && !editing && (
          <Notice tone="ok">Saved — {windowSummary(state.data?.callingWindow ?? null)}.</Notice>
        )}

        {editing ? (
          <>
            <WindowChoice
              chosen={draft.mode}
              disabled={pending}
              onChoose={(mode) => setDraft({ ...draft, mode })}
            />
            <CallingWindowFields
              draft={draft}
              disabled={pending}
              errors={state.status === "invalid" ? state.fieldErrors : {}}
              onChange={setDraft}
            />
            <div className="flex flex-wrap gap-2">
              <Button pending={pending} type="submit" size="sm" variant="primary" disabled={pending || empty}>
                "Save hours"
              </Button>
              <Button type="button" size="sm" disabled={pending} onClick={cancel}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          canWrite && (
            <div>
              <Button type="button" size="sm" onClick={begin}>
                Change hours
              </Button>
            </div>
          )
        )}

        <p className="border-t border-[var(--hairline)] pt-3 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          Consent and do-not-call are checked per number on every call, whatever this says. A
          window narrows the permitted hours and never widens them
          {editing ? ", and a change takes effect on the next sweep." : "."}
        </p>
      </Stack>
    </form>
  );
};
