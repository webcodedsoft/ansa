"use client";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * Tabs over one entity.
 *
 * They switch panels in place and never navigate. A tab is a view of the thing
 * you are already looking at; the moment one becomes a link somewhere else it
 * throws you out of the record you were editing, which is exactly the bug this
 * component exists to make impossible.
 *
 * Panels render eagerly and hide with `hidden` rather than unmounting, so a
 * half-filled form is still there when you come back to it.
 */
export interface TabDef {
  readonly id: string;
  readonly label: ReactNode;
  readonly panel: ReactNode;
  /**
   * Something in this panel was rejected, and the panel may not be the open one.
   *
   * A form can span these tabs — the agent workspace has one across nine — so a field error
   * can land somewhere nobody is looking. Without a mark on the tab the only evidence is a
   * line at the top of the page saying some field somewhere is wrong, which is barely better
   * than the silence it replaced.
   */
  readonly problem?: boolean;
}

export const Tabs = ({ tabs, initial }: { readonly tabs: readonly TabDef[]; readonly initial?: string }) => {
  const first = tabs[0];
  const [open, setOpen] = useState(initial ?? first?.id ?? "");

  if (first === undefined) return null;

  return (
    <>
      <div role="tablist" className="mb-[22px] flex gap-0.5 overflow-x-auto border-b border-[var(--hairline)] pt-1">
        {tabs.map((tab) => {
          const on = tab.id === open;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setOpen(tab.id)}
              className={cn(
                "-mb-px border-b-2 px-3 pt-2.5 pb-3 text-[13.5px] whitespace-nowrap transition-colors",
                on
                  ? "border-[var(--accent)] font-medium text-[var(--ink)]"
                  : "border-transparent text-[var(--ink-3)] hover:text-[var(--ink-2)]",
              )}
            >
              {tab.label}
              {tab.problem === true && (
                <span
                  className="ml-1.5 inline-block size-[7px] rounded-full bg-[var(--bad)] align-middle"
                  /* Colour alone would be the whole signal for anyone who cannot see it, and
                     the panel it points at is hidden. The name carries it instead. */
                  role="img"
                  aria-label="has a problem"
                />
              )}
            </button>
          );
        })}
      </div>

      {tabs.map((tab) => (
        <div key={tab.id} role="tabpanel" hidden={tab.id !== open} className={cn(tab.id === open && "ansa-enter")}>
          {tab.panel}
        </div>
      ))}
    </>
  );
};

/** An exclusive choice of two or three, inline. Not for navigation. */
export const Segmented = <T extends string>({
  options,
  value,
  onChange,
  label,
  labels,
}: {
  readonly options: readonly T[];
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly label?: string;
  /**
   * What each option is called on screen, when that differs from the value.
   *
   * The value is what gets stored, so it stays a lowercase identifier; "Read back" is what
   * a person reads. Optional, because for options that are already words — a weekday, a
   * risk tier — a second mapping to maintain would be the worse trade.
   */
  readonly labels?: Readonly<Record<T, string>>;
}) => (
  <div
    role="radiogroup"
    aria-label={label}
    className="inline-flex gap-0.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-0.5"
  >
    {options.map((option) => (
      <button
        key={option}
        type="button"
        role="radio"
        aria-checked={option === value}
        onClick={() => onChange(option)}
        className={cn(
          "rounded-md px-2.5 py-1 text-[12.5px] transition-colors",
          option === value
            ? "bg-[var(--surface-solid)] font-medium text-[var(--ink)] shadow-[var(--shadow-s)]"
            : "text-[var(--ink-3)] hover:text-[var(--ink-2)]",
        )}
      >
        {labels?.[option] ?? option}
      </button>
    ))}
  </div>
);

/** An on/off setting. Pass it to `SettingRow` as the control. */
export const Toggle = ({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cn(
      "relative h-[25px] w-[42px] flex-none rounded-full border transition-colors disabled:opacity-55",
      checked ? "border-transparent bg-[var(--accent)]" : "border-[var(--hairline)] bg-[var(--surface-2)]",
    )}
  >
    <span
      className={cn(
        "absolute top-0.5 left-0.5 size-[19px] rounded-full transition-transform duration-150",
        checked ? "translate-x-[17px] bg-[var(--accent-on)]" : "bg-[var(--ink-3)]",
      )}
    />
  </button>
);
