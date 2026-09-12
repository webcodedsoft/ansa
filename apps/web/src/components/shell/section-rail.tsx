import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

/**
 * The left-hand list of a settings page — the organisation's, or your own.
 *
 * One component so the two pages cannot drift: same widths, same active mark, same place for
 * a count or a state beside a label. The section is the URL on both, so an item is a link
 * and the page decides which one is current.
 */
export interface RailItem {
  readonly href: string;
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly active?: boolean;
  /** A count or a state tag, sat at the end of the row. */
  readonly trailing?: ReactNode;
}

export interface RailGroup {
  readonly label: string;
  readonly items: readonly RailItem[];
}

export const SectionRail = ({ groups }: { readonly groups: readonly RailGroup[] }) => (
  <nav aria-label="Sections" className="flex flex-col gap-0.5 lg:sticky lg:top-6">
    {groups.map((group, index) => (
      <div key={group.label} className="flex flex-col gap-0.5">
        <span
          className={cn(
            "px-2.5 pb-1.5 font-mono text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-3)] uppercase",
            index === 0 ? "pt-1" : "pt-4",
          )}
        >
          {group.label}
        </span>
        {group.items.map(({ href, label, Icon, active = false, trailing }) => (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] text-[var(--ink-2)] hover:bg-[var(--surface-2)]",
              active && "bg-[var(--surface-2)] font-medium text-[var(--ink)] shadow-[inset_2px_0_0_var(--accent)]",
            )}
          >
            <Icon aria-hidden className="size-4 text-[var(--ink-3)]" />
            {label}
            {trailing !== undefined && <span className="ml-auto flex items-center">{trailing}</span>}
          </Link>
        ))}
      </div>
    ))}
  </nav>
);
