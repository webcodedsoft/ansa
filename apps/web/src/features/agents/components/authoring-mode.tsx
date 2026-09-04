"use client";

import { Check } from "lucide-react";

import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import type { CapturedField } from "../agents.schema";

/**
 * How somebody builds an agent, and the one thing that choice decides afterwards.
 *
 * An agent is configured across ten tabs and the authoring mode owns exactly one of them.
 * A form-authored agent edits its questions on Data captured; a flow-authored one draws
 * them on the canvas and reads them there. Everything else — name, persona, instructions,
 * keyterms, greeting, barge-in, answering-machine detection, voice, speaking rate,
 * policies, knowledge, tools, number, hours, transfer target, versions — is the same
 * screen and the same edit in either mode. Locking more than one tab would strand
 * settings with nowhere to change them, which is the mistake this note exists to prevent.
 *
 * The choice is offered on the create screen rather than on a page in front of it: asking
 * somebody to pick an authoring model before they have seen either one is a question they
 * cannot answer.
 */

export type AuthoringMode = "form" | "flow";

/**
 * What an agent is until somebody says otherwise.
 *
 * Also what every screen assumes about an agent whose mode it cannot read — the field is
 * new, and an agent created before it existed was authored as a form.
 */
export const DEFAULT_AUTHORING_MODE: AuthoringMode = "form";

interface ModeSpec {
  readonly id: AuthoringMode;
  readonly label: string;
  /** One line. What the call is like, not what the editor is like. */
  readonly blurb: string;
  readonly recommended?: boolean;
}

const MODES: readonly ModeSpec[] = [
  {
    id: "form",
    label: "A form",
    blurb: "The agent asks its questions in one order, top to bottom, and every caller is asked the same ones.",
    recommended: true,
  },
  {
    id: "flow",
    label: "A flow",
    blurb: "Steps wired together on a canvas, so the call can branch on what the caller says and skip what does not apply.",
  },
];

/**
 * The sentence that makes this a decision rather than a trap.
 *
 * Both directions are possible, but they are not the same size of change, and somebody
 * choosing here is entitled to know that before they choose rather than after. A form
 * widens into a graph without losing anything; a graph narrowed back to a list has to
 * drop whatever only existed because the call could branch.
 */
export const AUTHORING_ASYMMETRY =
  "A form can become a flow at any time. Turning a flow back into a form removes its branches, so it asks first.";

const Option = ({
  mode,
  selected,
  onSelect,
}: {
  readonly mode: ModeSpec;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={cn(
      "surface flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors",
      selected
        ? "border-[color-mix(in_srgb,var(--accent)_42%,transparent)] bg-[var(--accent-soft)]"
        : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
    )}
  >
    <span className="flex w-full items-center gap-2">
      <span className="flex-1 text-[14px] font-semibold tracking-[-0.012em]">{mode.label}</span>
      {mode.recommended === true && <Tag>Recommended</Tag>}
      {selected && <Check aria-hidden className="size-4 flex-none text-[var(--accent)]" />}
    </span>
    <span className="text-[12.5px] text-[var(--ink-3)]">{mode.blurb}</span>
  </button>
);

/** The choice itself. Same card as a template card, because it is the same kind of pick. */
export const AuthoringModeChoice = ({
  value,
  onChange,
}: {
  readonly value: AuthoringMode;
  readonly onChange: (next: AuthoringMode) => void;
}) => (
  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
    {MODES.map((mode) => (
      <Option
        key={mode.id}
        mode={mode}
        selected={mode.id === value}
        onSelect={() => onChange(mode.id)}
      />
    ))}
  </div>
);

/**
 * A question a flow-authored agent asks, as the Data captured tab reads it.
 *
 * The same value as a `CapturedField` plus the one thing a list cannot express: a graph can
 * put a question on a branch, so "when is this asked" stops being "always" for everybody.
 * That is the column the graph earns on that screen.
 */
export interface FlowQuestion {
  /** The value's name, as tools receive it. */
  readonly key: string;
  /** How the agent asks, in the agent's own words. */
  readonly prompt: string;
  readonly type: CapturedField["type"];
  readonly confirm: CapturedField["confirm"];
  /**
   * The branch this question sits on, phrased to complete "asked …" — "when looking to
   * rent". Null when every call reaches it.
   */
  readonly asked: string | null;
}
