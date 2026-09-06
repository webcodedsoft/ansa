"use client";

import { useActionState, useState, type ReactNode } from "react";

import {
  Card,
  ChoiceChips,
  minutesLabel,
  Notice,
  SelectField,
  Stack,
  SubmitButton,
  TextAreaField,
  TextField,
} from "@/components/ui";
import { CAMPAIGN_LIMITS } from "@ansa/shared";

import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { saveBriefAction, type BriefState } from "../campaigns.actions";
import { OutcomeChips } from "./outcome-chips";

const START: BriefState = idleForm();

export interface BriefValues {
  readonly purpose: string | null;
  readonly opening: string | null;
  readonly outcomes: readonly string[] | null;
  readonly voicemail: { readonly mode: string } | null;
  readonly maxAttempts: number;
  readonly retryAfterMinutes: number;
}

/**
 * One question of the brief: its title and reason on the left, its controls on the right.
 *
 * The left column is deliberately narrow and deliberately quiet — it is a rail to glance at,
 * not a paragraph to read before the fields. On a narrow screen it folds above the fields,
 * which is the same order the stacked version had, so nothing is lost there.
 */
const Section = ({
  title,
  why,
  first = false,
  children,
}: {
  readonly title: string;
  readonly why: string;
  readonly first?: boolean;
  readonly children: ReactNode;
}) => (
  <div className={cn("grid gap-x-8 gap-y-3 lg:grid-cols-[240px_minmax(0,1fr)]", first ? "pb-6" : "py-6")}>
    <div>
      <h3 className="text-[13.5px] leading-tight font-semibold tracking-[-0.012em] text-[var(--ink)]">
        {title}
      </h3>
      <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">{why}</p>
    </div>
    <div className="max-w-[62ch]">
      <Stack gap="md">{children}</Stack>
    </div>
  </div>
);

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
  verdictSets,
}: {
  readonly campaignId: string;
  readonly values: BriefValues;
  readonly editable: boolean;
  readonly canWrite: boolean;
  /** The catalogue's verdict sets, for the suggestions under the verdicts box. */
  readonly verdictSets?: readonly (readonly string[])[];
}) => {
  const [state, action, pending] = useActionState(saveBriefAction, START);
  const [mode, setMode] = useState(values.voicemail?.mode ?? "hang_up");
  useFormToast(state, () => "Saved.");

  const disabled = !editable || !canWrite;

  return (
    /* One card, three rows, each row two columns: what the section is *for* on the left, the
       controls on the right. The previous cut had the same three sections as three stacked
       cards with the form pinned to a 70ch column, which left forty percent of every card
       empty and made the tab three walls of settings prose. Putting the explanation beside
       the fields instead of above them is what turns it from something you read into
       something you scan — and halves the height. */
    <form action={action}>
      <input type="hidden" name="campaignId" value={campaignId} />

      <div className="flex flex-col gap-3.5">
        {!editable && (
          <Notice tone="info">
            This campaign has started, so what it says is fixed. A call may already be in
            flight, and the reason somebody was rung should not change while they are being
            rung. To say something different, duplicate it.
          </Notice>
        )}

        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}

        <Card>
          <div className="divide-y divide-[var(--hairline)]">
            <Section
              title="What it says"
              why="The agent opens with this. Everything else — the voice, the manner, the tools — comes from the agent it uses, which is what lets one agent run more than one campaign."
              first
            >
              <TextField
                label="Why we are calling"
                name="purpose"
                defaultValue={values.purpose ?? ""}
                disabled={disabled}
                required
                error={state.fieldErrors["purpose"]}
                placeholder="to confirm your viewing at {property} on {when}"
                hint="One line, in your words. Anything in {braces} is filled in per person from what is already known: {name}, and any answer a previous call captured."
              />
              <TextAreaField
                label="Opening line"
                name="opening"
                defaultValue={values.opening ?? ""}
                disabled={disabled}
                error={state.fieldErrors["opening"]}
                placeholder="Leave empty and the agent composes one from the reason above."
                hint="Only if you want the exact words. It always says who it is and which company first, whatever is written here."
              />
            </Section>

            <Section
              title="What counts as done"
              why="The verdicts the agent may record at the end of a call. They are what the breakdown on this page counts, so they are the campaign's own measure of whether it worked."
            >
              <OutcomeChips
                label="Verdicts"
                name="outcomes"
                initial={values.outcomes ?? []}
                disabled={disabled}
                max={CAMPAIGN_LIMITS.outcomes}
                maxLength={CAMPAIGN_LIMITS.outcomeLength}
                error={state.fieldErrors["outcomes"]}
                suggestFrom={verdictSets}
              />
            </Section>

            <Section
              title="How hard it tries"
              why="What happens when nobody picks up. The consent rules and the calling window still apply on every attempt, and four hours between tries moves a retry to a different part of the day — three calls in ten minutes is harassment."
            >
              <SelectField
                label="If a machine answers"
                name="voicemailMode"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                disabled={disabled}
                hint={
                  mode === "leave_message"
                    ? "Says who rang and the number to call back, and nothing else. Never why — an answerphone plays out loud in a room."
                    : "Stays silent. Right when the subject alone would embarrass somebody in a room where the machine is played out loud."
                }
              >
                <option value="hang_up">Hang up</option>
                <option value="leave_message">Leave the standard message</option>
              </SelectField>
              <div className="flex flex-col gap-4">
                <ChoiceChips
                  label="Try at most"
                  name="maxAttempts"
                  presets={[1, 2, 3, 5]}
                  defaultValue={values.maxAttempts}
                  disabled={disabled}
                  error={state.fieldErrors["maxAttempts"]}
                  hint="Times, per person."
                />
                <ChoiceChips
                  label="Wait between tries"
                  name="retryAfterMinutes"
                  presets={[15, 30, 60, 120, 240, 1440, 2880, 10080]}
                  format={minutesLabel}
                  defaultValue={values.retryAfterMinutes}
                  disabled={disabled}
                  error={state.fieldErrors["retryAfterMinutes"]}
                  hint="Before the next attempt at somebody who did not pick up."
                />
              </div>
            </Section>
          </div>

          {!disabled && (
            <div className="border-t border-[var(--hairline)] pt-4">
              <SubmitButton pending={pending} idle="Save brief" busy="Saving…" />
            </div>
          )}
        </Card>
      </div>
    </form>
  );
};
