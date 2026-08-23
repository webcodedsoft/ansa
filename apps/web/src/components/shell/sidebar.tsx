"use client";

import {
  Activity, Bot, ChevronsUpDown, FileText, KeyRound, Link2, ListChecks, LogOut,
  Phone, PhoneCall, Plus, ScrollText, ShieldCheck, Table2, Users, Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { cn } from "@/lib/cn";

import { NAV_GROUPS, allowedDestinations, type Destination } from "./navigation";

/** One icon per destination, keyed by href so the list stays the single source. */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "/calls": PhoneCall,
  "/live": Activity,
  "/review": ListChecks,
  "/data": Table2,
  "/metrics": FileText,
  "/agents": Bot,
  "/agents/new": Plus,
  "/tools": Wrench,
  "/numbers": Phone,
  "/webhooks": Link2,
  "/credentials": KeyRound,
  "/members": Users,
  "/invitations": Users,
  "/consent": ShieldCheck,
  "/audit": ScrollText,
};

const isActive = (pathname: string, href: string): boolean => {
  // `/agents/new` must not light up `/agents`, but `/calls/<id>` must light up
  // `/calls` — otherwise the highlight vanishes the moment you open a record.
  if (href === "/agents") return pathname === "/agents" || /^\/agents\/(?!new$)/.test(pathname);
  return pathname === href || pathname.startsWith(`${href}/`);
};

export const Sidebar = ({
  organisation,
  user,
  role,
  capabilities,
  counts,
  signOut,
  collapsed = false,
}: {
  readonly organisation: string;
  readonly user: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  /** Live tallies by href, from the layout. Absent means "no badge", never "0". */
  readonly counts?: Readonly<Record<string, number>>;
  readonly signOut: () => Promise<void>;
  /** Icons only. The labels are the first thing to go when width is scarce. */
  readonly collapsed?: boolean;
}) => {
  const pathname = usePathname();
  const allowed = allowedDestinations(capabilities);
  const initials = organisation.slice(0, 1).toUpperCase();

  const item = (d: Destination) => {
    const Icon = ICONS[d.href] ?? Bot;
    const on = isActive(pathname, d.href);
    return (
      <Link
        key={d.href}
        href={d.href}
        aria-current={on ? "page" : undefined}
        title={collapsed ? d.label : undefined}
        className={cn(
          "relative flex items-center gap-2.5 rounded-lg border py-1.5 text-[13.5px] transition-colors",
          collapsed ? "justify-center px-2" : "px-2.5",
          on
            ? "border-[var(--hairline)] bg-[var(--glass-hi)] font-medium text-[var(--ink)] shadow-[var(--shadow-s),var(--spec)]"
            : "border-transparent text-[var(--ink-2)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
        )}
      >
        {/* A short bar rather than a tinted pill: with sixteen destinations the
            selection has to read at a glance without the accent competing with
            every icon in the list. */}
        {on && !collapsed && (
          <span aria-hidden className="absolute top-1/2 -left-px h-[15px] w-[2.5px] -translate-y-1/2 rounded-r bg-[var(--accent)]" />
        )}
        <Icon className={cn("size-4 flex-none", on ? "text-[var(--accent)]" : "text-[var(--ink-3)]")} />
        {!collapsed && <span className="flex-1 truncate">{d.label}</span>}
        {!collapsed && counts?.[d.href] !== undefined && counts[d.href] !== 0 && (
          <span className="rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] px-1.5 py-px font-mono text-[10.5px] text-[var(--ink-3)] tabular-nums">
            {counts[d.href]}
          </span>
        )}
      </Link>
    );
  };

  return (
    // `h-full` is load-bearing, not tidying. The grid stretches the wrapper to
    // the row height, but this flex column has no height of its own — without
    // it the rail ends under the last nav item and the ground shows through
    // beneath, so the sidebar stops halfway down the window.
    <aside className="glass flex h-full min-h-0 flex-col rounded-none border-y-0 border-l-0">
      <div className={cn("flex items-center gap-2.5 py-3.5", collapsed ? "justify-center px-2" : "px-3")}>
        <span className="grid size-[30px] flex-none place-items-center rounded-[9px] bg-[linear-gradient(150deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,#2a6ad4))] text-[13px] font-bold text-[var(--accent-on)] shadow-[var(--shadow-s)]">
          {initials}
        </span>
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold tracking-[-0.012em]">
                {organisation}
              </span>
              <span className="block truncate text-[11.5px] text-[var(--ink-3)]">{role}</span>
            </span>
            {/* An affordance, not a control: a person belonging to two
                organisations expects to see the switch here even before the
                API can list them. It is disabled rather than absent so the
                shape of the finished product is honest. */}
            <ChevronsUpDown aria-hidden className="size-4 flex-none text-[var(--ink-3)] opacity-40" />
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {NAV_GROUPS.map((group) => {
          const items = allowed.filter((d) => d.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mt-3.5 first:mt-1">
              {!collapsed && (
                <h6 className="mb-1.5 px-2.5 font-mono text-[10px] font-medium tracking-[0.13em] text-[var(--ink-3)] uppercase">
                  {group}
                </h6>
              )}
              <div className="flex flex-col gap-0.5">{items.map(item)}</div>
            </div>
          );
        })}
      </div>

      <div
        className={cn(
          "flex items-center gap-2.5 border-t border-[var(--hairline)] p-2.5",
          collapsed && "flex-col",
        )}
      >
        <span className="grid size-[27px] flex-none place-items-center rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] text-[11px] font-semibold text-[var(--ink-2)]">
          {user.slice(0, 2).toUpperCase()}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium">{user}</span>
            <span className="block truncate text-[11px] text-[var(--ink-3)] capitalize">{role}</span>
          </span>
        )}
        <form action={signOut}>
          <button
            type="submit"
            title="Sign out"
            aria-label="Sign out"
            className="grid size-[26px] place-items-center rounded-lg text-[var(--ink-3)] transition-colors hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]"
          >
            <LogOut className="size-3.5" />
          </button>
        </form>
      </div>
    </aside>
  );
};
