"use client";

import { useActionState, useState } from "react";

import {
  Notice,
  NumberField,
  Panel,
  SectionHead,
  SelectField,
  Stack,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { saveBriefAction, type BriefState } from "../campaigns.actions";

const START: BriefState = idleForm();

export interface BriefValues {
  readonly purpose: string | null;
  readonly opening: string | null;
  readonly outcomes: readonly string[] | null;
  readonly voicemail: { readonly mode: string; readonly message?: string } | null;
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
}

/**
 * What this campaign is about.
 *
 * The four questions an operator has to answer before anybody is rung: why are we calling,
 * what should the agent say first, what counts as done, and what happens if a machine picks
 * up. Everything else about the call comes from the agent — the voice, the manner, the tools —
 * which is what lets one agent serve a reminder campaign on Monday and a follow-up on Friday.
 *
 * The purpose is the load-bearing field. `prompts/outbound.ts` tells the agent it must open by
 * saying who it is, which company, and why it is calling; this is the third, and without it
 * the model composes one. An invented reason for an unexpected call is what a scam sounds like
 * to whoever answers, which is why a campaign with no purpose cannot be started.
 *
 * Read-only once the campaign is running. Not out of caution: a call may already be in flight,
 * and somebody hearing "your viewing on Tuesday" must not have had the reason changed under
 * them halfway down the list.
 */
export const CampaignBrief = ({
  campaignId,
  values,
  editable,
  canWrite,
}: {
  readonly campaignId: string;
  readonly values: BriefValues;
  readonly editable: boolean;
  readonly canWrite: boolean;
}) => {
  const [state, action, pending] = useActionState(saveBriefAction, START);
  const [mode, setMode] = useState(values.voicemail?.mode ?? "hang_up");
  useFormToast(state, () => "Saved.");

  const disabled = !editable || !canWrite;

  return (
    <Panel>
      <SectionHead>What this call is about</SectionHead>
      <p className="mb-3.5 max-w-[62ch] text-[12.5px] leading-relaxed text-[var(--ink-3)]">
        The agent says this in the opening. Everything else — the voice, the manner, the tools —
        comes from the agent it uses, which is what lets one agent run more than one campaign.
      </p>

      {!editable && (
        <Notice tone="info">
          This campaign has started, so what it says is fixed. A call may already be in flight,
          and the reason somebody was rung should not change while they are being rung. To say
          something different, make a new campaign.
        </Notice>
      )}

      {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}

      <form action={action}>
        <input type="hidden" name="campaignId" value={campaignId} />
        <Stack gap="md">
          <TextField
            label="Why we are calling"
            name="purpose"
            defaultValue={values.purpose ?? ""}
            disabled={disabled}
            required
            error={state.fieldErrors["purpose"]}
            placeholder="to confirm your viewing at {property} on {when}"
            hint="One line, in your words — the agent says it in the first breath. Anything in {braces} is filled in per person from what is already known about them: {name}, and any answer a previous call captured, such as {area} or {lookingFor}."
          />

          <TextAreaField
            label="Opening line"
            name="opening"
            defaultValue={values.opening ?? ""}
            disabled={disabled}
            error={state.fieldErrors["opening"]}
            placeholder="Leave empty and the agent composes one from the reason above."
            hint="Only if you want the exact words. The agent always says who it is and which company first, whatever is written here."
          />

          <TextAreaField
            label="What counts as done"
            name="outcomes"
            defaultValue={(values.outcomes ?? []).join("\n")}
            disabled={disabled}
            error={state.fieldErrors["outcomes"]}
            placeholder={"confirmed\nrescheduled\ndeclined\ncall back later"}
            hint="One per line. The agent records one of these at the end, from what the person actually said. Leave empty if you only want the call made."
          />

          <SelectField
            label="If a machine answers"
            name="voicemailMode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            disabled={disabled}
            hint={
              mode === "leave_message"
                ? "Read exactly as written. A message left by mistake cannot be taken back."
                : "The safest answer, and the default. An agent talking to a greeting is billed for it and achieves nothing."
            }
          >
            <option value="hang_up">Hang up</option>
            <option value="leave_message">Leave a message</option>
          </SelectField>

          {mode === "leave_message" && (
            <TextAreaField
              label="The message to leave"
              name="voicemailMessage"
              defaultValue={values.voicemail?.message ?? ""}
              disabled={disabled}
              error={state.fieldErrors["voicemailMessage"]}
              hint="Written out rather than improvised: a model talking to a beep has nobody to correct it."
            />
          )}

          <div className="flex flex-wrap gap-3">
            <NumberField
              label="Try at most"
              name="maxAttempts"
              defaultValue={values.maxAttempts}
              min={1}
              max={10}
              disabled={disabled}
              error={state.fieldErrors["maxAttempts"]}
              hint="Times, per person, in total."
              className="w-40"
            />
            <NumberField
              label="Wait between tries"
              name="retryAfterMinutes"
              defaultValue={values.retryAfterMinutes}
              min={15}
              step={15}
              disabled={disabled}
              error={state.fieldErrors["retryAfterMinutes"]}
              hint="Minutes. Four hours moves a retry to a different part of the day, which is the point — three calls in ten minutes is harassment."
              className="w-52"
            />
          </div>

          {!disabled && (
            <div>
              <SubmitButton pending={pending} idle="Save" busy="Saving…" />
            </div>
          )}
        </Stack>
      </form>
    </Panel>
  );
};
