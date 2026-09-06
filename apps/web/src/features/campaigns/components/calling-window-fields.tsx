"use client";

import { Notice, SelectField, Stack } from "@/components/ui";
import { cn } from "@/lib/cn";

/** Monday first, because a working week reads that way; the value is the API's own 0–6. */
export const DAYS: readonly { readonly value: number; readonly label: string; readonly full: string }[] = [
  { value: 1, label: "M", full: "Monday" },
  { value: 2, label: "T", full: "Tuesday" },
  { value: 3, label: "W", full: "Wednesday" },
  { value: 4, label: "T", full: "Thursday" },
  { value: 5, label: "F", full: "Friday" },
  { value: 6, label: "S", full: "Saturday" },
  { value: 0, label: "S", full: "Sunday" },
];

export const WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

export type WindowMode = "default" | "custom";

/** The shape both screens hold in state, and the shape the strip draws. */
export interface WindowDraft {
  readonly mode: WindowMode;
  readonly startHour: number;
  readonly endHour: number;
  readonly days: ReadonlySet<number>;
}

export const DEFAULT_DRAFT: WindowDraft = {
  mode: "default",
  startHour: 8,
  endHour: 20,
  days: new Set(WEEKDAYS),
};

/** What the API stores, from what the form holds. Null is the default bound. */
export const draftToWindow = (
  draft: WindowDraft,
): { readonly startHour: number; readonly endHour: number; readonly weekdays: readonly number[] } | null =>
  draft.mode === "default"
    ? null
    : { startHour: draft.startHour, endHour: draft.endHour, weekdays: [...draft.days] };

/** What the form should hold, from what the API stored. */
export const windowToDraft = (
  window: { readonly startHour: number; readonly endHour: number; readonly weekdays: readonly number[] } | null,
): WindowDraft =>
  window === null
    ? DEFAULT_DRAFT
    : { mode: "custom", startHour: window.startHour, endHour: window.endHour, days: new Set(window.weekdays) };

const hourOptions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((hour) => (
    <option key={hour} value={hour}>
      {`${String(hour).padStart(2, "0")}:00`}
    </option>
  ));

/**
 * One of two ways the phone may ring, as a choice rather than a checkbox.
 *
 * A checkbox called "only call within set hours" reads as though leaving it off means *no*
 * limit, which is the opposite of true — the consent rules bound every campaign to
 * 08:00–20:00 WAT whatever this says. Two cards that both state their hours make the real
 * choice visible: keep the bound, or narrow it.
 */
export const WindowChoice = ({
  chosen,
  disabled = false,
  onChoose,
}: {
  readonly chosen: WindowMode;
  readonly disabled?: boolean;
  readonly onChoose: (next: WindowMode) => void;
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
          disabled={disabled}
          onClick={() => onChoose(option.id)}
          className={cn(
            "rounded-lg border p-3.5 text-left transition-colors disabled:opacity-60",
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
 * The hours and the days of a narrowed window, as controls.
 *
 * Shared by the page that creates a campaign and the card that edits one, so the two cannot
 * drift into offering different windows. The field names are the ones `windowFromForm`
 * reads — `windowEnabled`, `startHour`, `endHour` and the repeated `weekdays` — and the day
 * pills post hidden inputs under that last name, so either screen can submit this as a form.
 *
 * Renders nothing in default mode: the choice above it is the whole control then, and
 * hidden inputs for a window nobody chose would submit one that fails validation for saying
 * nothing.
 */
export const CallingWindowFields = ({
  draft,
  disabled = false,
  errors = {},
  onChange,
}: {
  readonly draft: WindowDraft;
  readonly disabled?: boolean;
  readonly errors?: Readonly<Record<string, string | undefined>>;
  readonly onChange: (next: WindowDraft) => void;
}) => {
  if (draft.mode !== "custom") return null;

  const toggleDay = (value: number): void => {
    const next = new Set(draft.days);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange({ ...draft, days: next });
  };

  const orderWrong = draft.endHour <= draft.startHour;
  const noDays = draft.days.size === 0;

  return (
    <Stack gap="sm" className="rounded-lg border border-[var(--hairline)] p-3.5">
      {/* What `windowFromForm` reads. A hidden input rather than a checkbox, because the
          choice above is already the control and two of them would disagree. */}
      <input type="hidden" name="windowEnabled" value="on" />

      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          label="From"
          name="startHour"
          value={draft.startHour}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, startHour: Number(event.target.value) })}
          error={errors["startHour"]}
          className="min-w-28"
        >
          {hourOptions(0, 23)}
        </SelectField>
        <SelectField
          label="Until"
          name="endHour"
          value={draft.endHour}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, endHour: Number(event.target.value) })}
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
            const on = draft.days.has(day.value);
            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={on}
                aria-label={day.full}
                title={day.full}
                disabled={disabled}
                onClick={() => toggleDay(day.value)}
                className={cn(
                  "size-9 rounded-full border text-[12.5px] font-medium transition-colors disabled:opacity-60",
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
        {/* The pills are the control; these carry their values to the action under the name
            it already reads. */}
        {[...draft.days].map((day) => (
          <input key={day} type="hidden" name="weekdays" value={day} />
        ))}
      </fieldset>

      {noDays && (
        <Notice tone="warn">No days are selected, so this campaign would never place a call.</Notice>
      )}
      {orderWrong && (
        <Notice tone="warn">
          &ldquo;Until&rdquo; is not after &ldquo;from&rdquo;, so the window is empty.
        </Notice>
      )}
      {errors["weekdays"] !== undefined && <Notice tone="error">{errors["weekdays"]}</Notice>}
    </Stack>
  );
};
