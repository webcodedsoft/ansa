"use client";

import {
  Activity, Bot, ChevronsUpDown, FileText, ListChecks, LogOut, PhoneCall, Settings, Table2, Users, Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";

import { IconButton } from "@/components/ui";
import { cn } from "@/lib/cn";

import { allowedDestinations, isSettingsPath, settingsDestinations, type Destination } from "./navigation";

/** One icon per sidebar row, keyed by href so the list stays the single source. */
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  "/calls": PhoneCall,
  "/live": Activity,
  "/review": ListChecks,
  "/data": Table2,
  "/contacts": Users,
  "/metrics": FileText,
  "/agents": Bot,
  "/tools": Wrench,
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
  const allowed = allowedDestinations(capabilities).filter((d) => d.inSidebar !== false);
  const initials = organisation.slice(0, 1).toUpperCase();

  /* Settings is one row for seven pages. It goes to the first of them this caller may
     open — usually the organisation itself — and lights up on any of them, because the
     tabs across the top of those pages are the navigation from there. */
  const settings = settingsDestinations(capabilities)[0];

  const row = (href: string, label: string, Icon: ComponentType<{ className?: string }>, on: boolean, count?: number) => (
    <Link
      key={href}
      href={href}
      aria-current={on ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex items-center gap-2.5 rounded-lg border py-[5px] text-[13.5px] transition-colors",
        collapsed ? "justify-center px-2" : "px-2.5",
        on
          ? "border-[var(--hairline)] bg-[var(--glass-hi)] font-medium text-[var(--ink)] shadow-[var(--shadow-s),var(--spec)]"
          : "border-transparent text-[var(--ink-2)] hover:bg-[var(--glass-hi)] hover:text-[var(--ink)]",
      )}
    >
      {/* A short bar rather than a tinted pill, so the selection reads at a glance without
          the accent competing with every icon in the list. */}
      {on && !collapsed && (
        <span aria-hidden className="absolute top-1/2 -left-px h-[15px] w-[2.5px] -translate-y-1/2 rounded-r bg-[var(--accent)]" />
      )}
      <Icon className={cn("size-4 flex-none", on ? "text-[var(--accent)]" : "text-[var(--ink-3)]")} />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
      {!collapsed && count !== undefined && count !== 0 && (
        <span className="rounded-full border border-[var(--hairline)] bg-[var(--surface-2)] px-1.5 py-px font-mono text-[10.5px] text-[var(--ink-3)] tabular-nums">
          {count}
        </span>
      )}
    </Link>
  );

  const item = (d: Destination) => row(d.href, d.label, ICONS[d.href] ?? Bot, isActive(pathname, d.href), counts?.[d.href]);

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
        {(["Operate", "Build"] as const).map((group) => {
          const items = allowed.filter((d) => d.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} className="mt-3 first:mt-1">
              {!collapsed && (
                <h6 className="mb-1 px-2.5 font-mono text-[10px] font-medium tracking-[0.13em] text-[var(--ink-3)] uppercase">
                  {group}
                </h6>
              )}
              <div className="flex flex-col gap-px">{items.map(item)}</div>
            </div>
          );
        })}
        {settings !== undefined && (
          <div className="mt-3 border-t border-[var(--hairline)] pt-2.5">
            {row(settings.href, "Settings", Settings, isSettingsPath(pathname))}
          </div>
        )}
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
          <IconButton
            type="submit"
            title="Sign out"
            aria-label="Sign out"
            className="size-[26px] text-[var(--ink-3)]"
          >
            <LogOut className="size-3.5" />
          </IconButton>
        </form>
      </div>
    </aside>
  );
};
