/**
 * Every destination in the console, in one list.
 *
 * The sidebar renders it grouped and the command palette searches it flat, so
 * a new section is added once and appears in both. That matters more than it
 * looks: the two drifting apart is how a feature ends up reachable by search
 * and invisible in the navigation, or the reverse.
 *
 * Organisation-level only. Anything belonging to a single agent lives in that
 * agent's own tabs, because a second navigation competing with this one is
 * what made the earlier design feel unfinished.
 */
export interface Destination {
  readonly href: string;
  readonly label: string;
  readonly group: NavGroup;
  /** Hidden when the caller lacks it. Presentation only — the API still checks. */
  readonly capability?: string;
  /**
   * Reachable from the sidebar as its own row. False for a destination that is a button
   * on the page it belongs to and only needs to exist here for the palette and the
   * breadcrumb — "Build an agent" is the New agent button on the agents list.
   */
  readonly inSidebar?: false;
}

/**
 * Three groups, and the third is one row.
 *
 * Sixteen rows under four headings was a sidebar longer than the window. What shortened it
 * was not tighter padding but a distinction: *Operate* is what you look at every day,
 * *Build* is what you make, and everything else is configuration — set once, revisited
 * rarely, and better as tabs on one Settings page than as seven rows competing with Calls.
 */
export type NavGroup = "Operate" | "Build" | "Settings";

export const NAV_GROUPS: readonly NavGroup[] = ["Operate", "Build", "Settings"];

export const DESTINATIONS: readonly Destination[] = [
  { href: "/calls", label: "Calls", group: "Operate", capability: "calls:read" },
  { href: "/live", label: "Live", group: "Operate", capability: "calls:read" },
  { href: "/review", label: "Review queue", group: "Operate", capability: "calls:read" },
  { href: "/data", label: "Collected data", group: "Operate", capability: "calls:read" },
  { href: "/contacts", label: "Contacts", group: "Operate", capability: "contacts:read" },
  { href: "/metrics", label: "Metrics", group: "Operate", capability: "calls:read" },

  { href: "/agents", label: "Agents", group: "Build", capability: "config:read" },
  { href: "/agents/new", label: "Build an agent", group: "Build", capability: "config:write", inSidebar: false },
  { href: "/tools", label: "Tool registry", group: "Build", capability: "config:read" },

  // In the order the Settings tabs run: the company first, then how calls reach it, then
  // who may sign in, then the records.
  { href: "/organisation", label: "Organisation", group: "Settings", capability: "config:read" },
  { href: "/numbers", label: "Numbers", group: "Settings", capability: "config:read" },
  { href: "/webhooks", label: "Webhooks", group: "Settings", capability: "config:read" },
  { href: "/credentials", label: "Credentials", group: "Settings", capability: "config:write" },
  { href: "/members", label: "Members", group: "Settings", capability: "members:read" },
  { href: "/invitations", label: "Invitations", group: "Settings", capability: "invitations:read" },
  { href: "/consent", label: "Consent & do-not-call", group: "Settings", capability: "config:read" },
  { href: "/audit", label: "Audit log", group: "Settings", capability: "calls:read" },
];

export const allowedDestinations = (capabilities: readonly string[]): readonly Destination[] =>
  DESTINATIONS.filter((d) => d.capability === undefined || capabilities.includes(d.capability));

/** The Settings pages this caller may open, in tab order. */
export const settingsDestinations = (capabilities: readonly string[]): readonly Destination[] =>
  allowedDestinations(capabilities).filter((d) => d.group === "Settings");

export const isSettingsPath = (pathname: string): boolean =>
  DESTINATIONS.some((d) => d.group === "Settings" && (pathname === d.href || pathname.startsWith(`${d.href}/`)));
