import { ArrowRight, GitBranch, ListOrdered } from "lucide-react";
import Link from "next/link";

import { Tag } from "@/components/ui";

import { AUTHORING_ASYMMETRY } from "./authoring-mode";

interface BuilderOption {
  readonly href: string;
  readonly icon: typeof GitBranch;
  readonly name: string;
  /** What the call is like, not what the editor is like. */
  readonly blurb: string;
  /** Two or three concrete things it suits, so the choice is made on the conversation. */
  readonly suits: readonly string[];
  readonly recommended?: boolean;
}

const BUILDERS: readonly BuilderOption[] = [
  {
    href: "/agents/new/form",
    icon: ListOrdered,
    name: "Form Builder",
    blurb: "The agent asks its questions in one order, top to bottom, and every caller is asked the same ones.",
    suits: ["Taking a message or a booking", "Collecting the same details from everyone", "Getting a first agent live today"],
    recommended: true,
  },
  {
    href: "/agents/new/flow",
    icon: GitBranch,
    name: "Flow Builder",
    blurb: "Steps wired together on a canvas, so the call can branch on what the caller says and skip what does not apply.",
    suits: ["Rent or buy, new or existing, yes or no", "Different questions for different callers", "A tool or a hand-over partway through"],
  },
];

/**
 * The two builders, as two boxes.
 *
 * Whole-card links: the box is the choice, and a button inside it would make the rest of
 * the card an inert border around the one thing that works. The asymmetry sentence sits
 * above both because it is the one thing worth knowing before choosing rather than after.
 */
export const ChooseBuilder = () => (
  <div className="flex flex-col gap-3.5">
    <p className="max-w-[62ch] text-[13px] text-[var(--ink-3)]">{AUTHORING_ASYMMETRY}</p>
    <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
      {BUILDERS.map((builder) => (
        <Link
          key={builder.href}
          href={builder.href}
          className="surface group flex flex-col gap-3 rounded-xl border border-[var(--hairline)] p-5 transition-colors hover:border-[var(--accent)] focus-visible:border-[var(--accent)] focus-visible:outline-none"
        >
          <span className="flex items-center gap-3">
            <span className="grid size-10 flex-none place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]">
              <builder.icon aria-hidden className="size-5" />
            </span>
            <span className="flex-1 text-[16px] font-semibold tracking-[-0.015em]">{builder.name}</span>
            {builder.recommended === true && <Tag>Recommended</Tag>}
          </span>
          <span className="text-[13px] text-[var(--ink-2)]">{builder.blurb}</span>
          <ul className="flex flex-col gap-1 text-[12.5px] text-[var(--ink-3)]">
            {builder.suits.map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="mt-[7px] size-1 flex-none rounded-full bg-[var(--ink-3)]" />
                {line}
              </li>
            ))}
          </ul>
          <span className="mt-auto flex items-center gap-1.5 pt-1 text-[13px] font-medium text-[var(--accent)]">
            Open the {builder.name.toLowerCase()}
            <ArrowRight aria-hidden className="size-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      ))}
    </div>
  </div>
);
