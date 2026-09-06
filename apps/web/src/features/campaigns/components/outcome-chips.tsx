"use client";

import { useState, type KeyboardEvent } from "react";

import { CONTROL, Field } from "@/components/ui";
import { cn } from "@/lib/cn";

/**
 * The verdicts an agent may record, as chips.
 *
 * They were a textarea with "one per line" in the hint, which is the wrong control twice
 * over: a verdict is a short tag rather than a line of prose, and the only way to see what
 * was there was to read a column of text. Chips show the set at a glance, and the agent will
 * be picking from exactly this set at the end of every call, so the operator should see it
 * the way the agent does — as a short list of names.
 *
 * Posts under the same `outcomes` name the textarea used, joined with newlines, so the action
 * that reads it is unchanged. Enter or comma adds; backspace on an empty box removes the last;
 * duplicates are ignored rather than refused, because typing one twice is a slip and not an
 * error worth a message.
 *
 * `as="div"` on the field, because a `<label>` wrapping the remove buttons would send every
 * click on them to the text input instead.
 */
export const OutcomeChips = ({
  name,
  initial,
  disabled,
  max,
  maxLength,
  error,
  label,
}: {
  readonly name: string;
  readonly initial: readonly string[];
  readonly disabled: boolean;
  readonly max: number;
  readonly maxLength: number;
  readonly error?: string;
  /** The field's caption. The card it sits in already says what it is, so this can be terse. */
  readonly label: string;
}) => {
  const [chips, setChips] = useState<readonly string[]>(initial);
  const [draft, setDraft] = useState("");

  const add = (): void => {
    const value = draft.trim();
    setDraft("");
    if (value === "" || chips.includes(value) || chips.length >= max) return;
    setChips([...chips, value.slice(0, maxLength)]);
  };

  const remove = (which: string): void => setChips(chips.filter((chip) => chip !== which));

  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft === "" && chips.length > 0) {
      setChips(chips.slice(0, -1));
    }
  };

  const full = chips.length >= max;

  return (
    <Field
      label={label}
      hint={
        full
          ? "That is the most a campaign may have. Remove one to add another."
          : "The agent records one of these at the end, from what the person actually said. Press Enter after each. Leave empty if you only want the call made."
      }
      error={error}
      as="div"
    >
      {/* What the action reads. The chips are the control; this carries their values. */}
      <input type="hidden" name={name} value={chips.join("\n")} />

      <div
        className={cn(
          CONTROL,
          "flex h-auto min-h-[38px] flex-wrap items-center gap-1.5 py-1.5",
          disabled && "opacity-60",
        )}
      >
        {chips.map((chip) => (
          <span
            key={chip}
            className="flex items-center gap-1 rounded-full bg-[var(--accent-soft)] py-0.5 pr-1 pl-2.5 text-[12.5px] text-[var(--ink)]"
          >
            {chip}
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${chip}`}
                onClick={() => remove(chip)}
                className="flex size-4 items-center justify-center rounded-full text-[var(--ink-3)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
              >
                ×
              </button>
            )}
          </span>
        ))}
        {!disabled && !full && (
          <input
            type="text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKey}
            onBlur={add}
            maxLength={maxLength}
            placeholder={chips.length === 0 ? "e.g. confirmed, rescheduled, declined" : ""}
            aria-label="Add an outcome"
            className="min-w-[10rem] flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--ink-3)]"
          />
        )}
        {disabled && chips.length === 0 && (
          <span className="text-[13px] text-[var(--ink-3)]">None — the call is only made.</span>
        )}
      </div>
    </Field>
  );
};
