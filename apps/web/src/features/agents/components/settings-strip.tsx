"use client";

import { cn } from "@/lib/cn";

/**
 * The agent's own settings, along the top of the canvas instead of behind a button.
 *
 * This replaced a drawer, and the reason is the complaint that produced it: the greeting,
 * the voice, the policies and the tools are not settings *about* a call, they are part
 * of what the caller hears. A drawer said otherwise — it put them one click and one overlay
 * away from the steps they belong beside, and covered the drawing while you read them.
 *
 * So each is a button carrying its own value, and pressing it fills the pane the canvas
 * already has on the right. Nothing opens on top of anything; the call stays visible while
 * you change the voice that speaks it. Pressing the open one again gives that pane back to
 * whichever step was selected.
 */
export interface StripItem {
  readonly id: string;
  readonly label: string;
  /** The current value, shown on the button: "Ìdùnnú · 0.95×", "7", "none yet". */
  readonly value: string;
  /** Something here was rejected, or is missing before the agent can answer a call. */
  readonly tone?: "problem" | "missing";
}

export const SettingsStrip = ({
  items,
  active,
  onSelect,
}: {
  readonly items: readonly StripItem[];
  readonly active: string | null;
  readonly onSelect: (id: string | null) => void;
}) => (
  <div
    role="tablist"
    aria-label="Agent settings"
    className="surface mb-3.5 flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--hairline)] px-2.5 py-2"
  >
    {items.map((item) => {
      const on = item.id === active;
      return (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={on}
          onClick={() => onSelect(on ? null : item.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] transition-colors",
            on
              ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
              : item.tone === "problem"
                ? "border-[var(--bad)] text-[var(--bad)] hover:bg-[var(--bad-soft)]"
                : item.tone === "missing"
                  ? "border-[var(--warn)] text-[var(--warn)] hover:bg-[var(--warn-soft)]"
                  : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)] hover:text-[var(--ink)]",
          )}
        >
          {item.label}
          {/* The value, not only the name. A row of nouns tells you what exists; this tells
              you what the agent will actually do, which is what you came to check. */}
          <span
            className={cn(
              "max-w-[16ch] truncate font-mono text-[11px]",
              on ? "text-[var(--accent)]" : item.tone === undefined ? "text-[var(--ink)]" : "",
            )}
          >
            {item.value}
          </span>
        </button>
      );
    })}
  </div>
);
