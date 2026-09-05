"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import {
  buttonClass,
  Card,
  Notice,
  SelectField,
  Stack,
  SubmitButton,
  TextField,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";

import { createCampaignAction, type CreateCampaignState } from "../campaigns.actions";
import { windowSummary } from "../campaigns.display";

const START: CreateCampaignState = idleForm();

/** Monday first, because a working week reads that way; the value is the API's own 0–6. */
const DAYS: readonly { readonly value: number; readonly label: string; readonly full: string }[] = [
  { value: 1, label: "M", full: "Monday" },
  { value: 2, label: "T", full: "Tuesday" },
  { value: 3, label: "W", full: "Wednesday" },
  { value: 4, label: "T", full: "Thursday" },
  { value: 5, label: "F", full: "Friday" },
  { value: 6, label: "S", full: "Saturday" },
  { value: 0, label: "S", full: "Sunday" },
];

const WEEKDAYS = [1, 2, 3, 4, 5];

const hourOptions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((hour) => (
    <option key={hour} value={hour}>
      {`${String(hour).padStart(2, "0")}:00`}
    </option>
  ));

export interface AgentChoice {
  readonly agentId: string;
  readonly name: string;
}

/**
 * One of two ways the phone may ring, as a choice rather than a checkbox.
 *
 * A checkbox called "only call within set hours" reads as though leaving it off means *no*
 * limit, which is the opposite of true — the consent rules bound every campaign to
 * 08:00–20:00 WAT whatever this says. Two cards that both state their hours make the real
 * choice visible: keep the bound, or narrow it.
 */
const WindowChoice = ({
  chosen,
  onChoose,
}: {
  readonly chosen: "default" | "custom";
  readonly onChoose: (next: "default" | "custom") => void;
}) => (
  <div className="grid gap-2.5 sm:grid-cols-2" role="radiogroup" aria-label="Calling hours">
    {(
      [
        {
          id: "default" as const,
          title: "Default hours",
          detail: "08:00–20:00 WAT, any day. What the consent rules already allow.",
        },
        {
          id: "custom" as const,
          title: "A narrower window",
          detail: "Pick the hours and days. It can only tighten the bound, never widen it.",
        },
      ]
    ).map((option) => {
      const active = chosen === option.id;
      return (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={active}
          onClick={() => onChoose(option.id)}
          className={cn(
            "rounded-lg border p-3.5 text-left transition-colors",
            active
              ? "border-[var(--accent)] bg-[var(--accent-soft)]"
              : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
          )}
        >
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className={cn(
                "size-3.5 flex-none rounded-full border",
                active
                  ? "border-[5px] border-[var(--accent)]"
                  : "border-[var(--hairline)] bg-[var(--surface-2)]",
              )}
            />
            <span className="text-[13.5px] font-medium">{option.title}</span>
          </span>
          <span className="mt-1.5 block text-[12px] leading-relaxed text-[var(--ink-3)]">
            {option.detail}
          </span>
        </button>
      );
    })}
  </div>
);

/**
 * Start a campaign, on its own page.
 *
 * It was a dialog, and a dialog was the wrong container: this is five decisions, one of which
 * — the calling window — is the thing operators most often get wrong, and a cramped modal
 * gave it a checkbox and seven tick boxes with no way to see what the result meant. A page
 * has room for the answer to be shown back.
 *
 * That is what the summary beside the form is for. It reads the same `windowSummary` the
 * campaign's own page uses, so what somebody is promised here is rendered by the code that
 * will describe it afterwards — the two cannot drift into saying different things about the
 * same window.
 *
 * The field names are unchanged and deliberately so: `windowEnabled`, `startHour`, `endHour`
 * and the repeated `weekdays` are what `windowFromForm` reads, and the day pills post hidden
 * inputs under that name rather than inventing a payload the action would ignore.
 */
export const NewCampaignForm = ({ agents }: { readonly agents: readonly AgentChoice[] }) => {
  const [state, action, pending] = useActionState(createCampaignAction, START);
  const errors = state.fieldErrors;

  const [name, setName] = useState("");
  const [agentId, setAgentId] = useState("");
  const [mode, setMode] = useState<"default" | "custom">("default");
  const [startHour, setStartHour] = useState(8);
  const [endHour, setEndHour] = useState(20);
  const [days, setDays] = useState<ReadonlySet<number>>(new Set(WEEKDAYS));

  const agentName = agents.find((agent) => agent.agentId === agentId)?.name ?? null;

  /* Built from the same shape the API stores, so the sentence below is the one the campaign
     page will show once this is saved rather than a second description of it. */
  const summary = useMemo(
    () =>
      mode === "default"
        ? windowSummary(null)
        : windowSummary({ startHour, endHour, weekdays: [...days] }),
    [mode, startHour, endHour, days],
  );

  const toggleDay = (value: number): void =>
    setDays((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  const orderWrong = mode === "custom" && endHour <= startHour;
  const noDays = mode === "custom" && days.size === 0;

  if (agents.length === 0) {
    return (
      <Card
        title="There is no agent to place the calls"
        description="A campaign is an agent ringing a list of people. Build the agent first and the campaign takes a minute."
      >
        <div>
          <Link href="/agents/new" className={buttonClass("primary")}>
            Build an agent
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <form action={action} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
      <Stack>
        <Card
          title="What it is"
          description="A name you will recognise on the list in a month, and the agent whose script and voice these calls run."
        >
          <Stack>
            <TextField
              label="Name"
              name="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. October arrears follow-up"
              error={errors["name"]}
            />

            <SelectField
              label="Agent"
              name="agentId"
              required
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              error={errors["agentId"]}
              hint="Its published configuration is what every call on this campaign uses."
            >
              <option value="" disabled>
                Choose an agent
              </option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </SelectField>
          </Stack>
        </Card>

        <Card
          title="When it may ring"
          description="Nigerian rules bound every outbound call to 08:00–20:00 WAT. This decides whether to narrow that further."
        >
          <Stack>
            <WindowChoice chosen={mode} onChoose={setMode} />

            {mode === "custom" && (
              <Stack gap="sm" className="rounded-lg border border-[var(--hairline)] p-3.5">
                {/* What `windowFromForm` reads. A hidden input rather than a checkbox, because
                    the choice above is already the control and two of them would disagree. */}
                <input type="hidden" name="windowEnabled" value="on" />

                <div className="flex flex-wrap items-end gap-3">
                  <SelectField
                    label="From"
                    name="startHour"
                    value={startHour}
                    onChange={(event) => setStartHour(Number(event.target.value))}
                    error={errors["startHour"]}
                    className="min-w-28"
                  >
                    {hourOptions(0, 23)}
                  </SelectField>
                  <SelectField
                    label="Until"
                    name="endHour"
                    value={endHour}
                    onChange={(event) => setEndHour(Number(event.target.value))}
                    error={errors["endHour"]}
                    className="min-w-28"
                  >
                    {hourOptions(1, 24)}
                  </SelectField>
                </div>

                <fieldset>
                  <legend className="mb-1.5 text-[11px] font-semibold tracking-[0.11em] text-[var(--ink-3)] uppercase">
                    Days
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS.map((day) => {
                      const on = days.has(day.value);
                      return (
                        <button
                          key={day.value}
                          type="button"
                          aria-pressed={on}
                          aria-label={day.full}
                          title={day.full}
                          onClick={() => toggleDay(day.value)}
                          className={cn(
                            "size-9 rounded-full border text-[12.5px] font-medium transition-colors",
                            on
                              ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-on)]"
                              : "border-[var(--hairline)] text-[var(--ink-3)] hover:border-[var(--ink-3)]",
                          )}
                        >
                          {day.label}
                        </button>
                      );
                    })}
                  </div>
                  {/* The pills are the control; these carry their values to the action under
                      the name it already reads. */}
                  {[...days].map((day) => (
                    <input key={day} type="hidden" name="weekdays" value={day} />
                  ))}
                </fieldset>

                {noDays && (
                  <Notice tone="warn">
                    No days are selected, so this campaign would never place a call.
                  </Notice>
                )}
                {orderWrong && (
                  <Notice tone="warn">
                    &ldquo;Until&rdquo; is not after &ldquo;from&rdquo;, so the window is empty.
                  </Notice>
                )}
                {errors["weekdays"] !== undefined && (
                  <Notice tone="error">{errors["weekdays"]}</Notice>
                )}
              </Stack>
            )}
          </Stack>
        </Card>

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}
      </Stack>

      {/* Sticky on a tall screen: the summary is what the buttons commit to, so it should not
          scroll away from them. */}
      <aside className="lg:sticky lg:top-5">
        <Card title="What you are creating">
          <Stack gap="sm">
            <p className="text-[15px] leading-snug font-medium text-[var(--ink)]">
              {name.trim() === "" ? "An unnamed campaign" : name.trim()}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
              {agentName === null ? (
                <span className="text-[var(--ink-3)]">No agent chosen yet.</span>
              ) : (
                <>
                  <span className="font-medium text-[var(--ink)]">{agentName}</span> places the
                  calls.
                </>
              )}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">{summary}</p>

            <hr className="my-1 border-0 border-t border-[var(--hairline)]" />

            {/* Stated, not buried. These hold whatever is chosen above, and somebody setting up
                their first campaign should not have to find that out from the docs. */}
            <ul className="flex flex-col gap-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
              <li>Starts as a draft with nobody on it. Nothing is dialled until you start it.</li>
              <li>Do-not-call and consent are checked per number, on every call.</li>
              <li>A number that refuses is never rung again by this campaign.</li>
            </ul>

            <div className="mt-1.5 flex flex-wrap gap-2">
              <SubmitButton pending={pending} idle="Create campaign" busy="Creating…" />
              <Link href="/campaigns" className={buttonClass()} aria-disabled={pending}>
                Cancel
              </Link>
            </div>
            <p className="text-[11.5px] text-[var(--ink-3)]">
              You add the people it rings on the next screen.
            </p>
          </Stack>
        </Card>
      </aside>
    </form>
  );
};
