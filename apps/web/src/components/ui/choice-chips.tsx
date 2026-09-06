"use client";

import { useState } from "react";

import { cn } from "@/lib/cn";

/**
 * A number chosen from a few sensible values, rather than typed into a box.
 *
 * "Wait 240 minutes" and "ring for 25 seconds" are not decisions anybody makes; "four hours"
 * and "half a minute" are. A box invites a value nobody meant, and a blank box that silently
 * means "the default" is the kind of setting somebody discovers from a phone bill. Chips put
 * the real choices in front of the person, and when there is a default it is a chip like the
 * others, so choosing it is something they did.
 *
 * Two honesty rules. A saved value that is not one of the presets — one the API accepted from
 * elsewhere, or one from before this existed — is shown as its own chip in its place, so the
 * page never displays a choice the row does not hold. And the value travels under the same
 * field name a number box would have posted, so nothing behind the form changes.
 *
 * Controlled when `value` is given, uncontrolled from `defaultValue` otherwise, the way a
 * plain input is — most forms here are uncontrolled and post on submit.
 */
export interface ChoiceChipsProps {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  /** The field name the hidden input posts under. */
  readonly name: string;
  readonly presets: readonly number[];
  /** How a value reads on its chip. Defaults to the number itself. */
  readonly format?: (value: number) => string;
  /**
   * The chip for "no value" — a default, or no cap. When given, the group can post empty.
   * Absent means one of the numbers must be chosen.
   */
  readonly none?: string;
  readonly value?: number | null;
  readonly defaultValue?: number | null;
  readonly onChange?: (next: number | null) => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

export const ChoiceChips = ({
  label,
  hint,
  error,
  name,
  presets,
  format = String,
  none,
  value,
  defaultValue = null,
  onChange,
  disabled = false,
  className,
}: ChoiceChipsProps) => {
  const [own, setOwn] = useState<number | null>(defaultValue);
  const chosen = value === undefined ? own : value;

  const numbers =
    chosen !== null && !presets.includes(chosen)
      ? [...presets, chosen].sort((a, b) => a - b)
      : presets;
  const options: readonly (number | null)[] = none === undefined ? numbers : [null, ...numbers];

  const pick = (next: number | null): void => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };

  return (
    <fieldset className={className}>
      <legend className="mb-1.5 block text-[13px] font-medium">{label}</legend>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const on = option === chosen;
          return (
            <button
              key={option ?? "none"}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pick(option)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[12.5px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-55",
                on
                  ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-on)]"
                  : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
                error !== undefined && !on && "border-[var(--bad)]",
              )}
            >
              {option === null ? none : format(option)}
            </button>
          );
        })}
      </div>
      {/* The chips are the control; this carries the choice under the name the form reads. */}
      <input type="hidden" name={name} value={chosen ?? ""} />
      {error !== undefined ? (
        <p className="mt-1.5 text-[12.5px] text-[var(--bad)]">{error}</p>
      ) : (
        hint !== undefined && <p className="mt-1.5 text-[12.5px] text-[var(--ink-3)]">{hint}</p>
      )}
    </fieldset>
  );
};

/** Minutes as people say them: 15m, 1h, 2 days, 1 week. */
export const minutesLabel = (minutes: number): string => {
  if (minutes % 10080 === 0) return minutes === 10080 ? "1 week" : `${minutes / 10080} weeks`;
  if (minutes % 1440 === 0) return minutes === 1440 ? "1 day" : `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};

/** Seconds as people say them: 15s, 1 min, 2 min. */
export const secondsLabel = (seconds: number): string =>
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;

/** Milliseconds as people say them: 500ms, 1s, 30s. */
export const millisLabel = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`);
