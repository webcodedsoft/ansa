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
}

export type NavGroup = "Operate" | "Agents" | "Connect" | "Organisation";

export const NAV_GROUPS: readonly NavGroup[] = ["Operate", "Agents", "Connect", "Organisation"];

export const DESTINATIONS: readonly Destination[] = [
  { href: "/calls", label: "Calls", group: "Operate", capability: "calls:read" },
  { href: "/live", label: "Live", group: "Operate", capability: "calls:read" },
  { href: "/review", label: "Review queue", group: "Operate", capability: "calls:read" },
  { href: "/metrics", label: "Metrics", group: "Operate", capability: "calls:read" },

  { href: "/agents", label: "All agents", group: "Agents", capability: "config:read" },
  { href: "/agents/new", label: "Build an agent", group: "Agents", capability: "config:write" },
  { href: "/tools", label: "Tool registry", group: "Agents", capability: "config:read" },

  { href: "/numbers", label: "Numbers", group: "Connect", capability: "config:read" },
  { href: "/webhooks", label: "Webhooks", group: "Connect", capability: "config:read" },
  { href: "/credentials", label: "Credentials", group: "Connect", capability: "config:write" },

  { href: "/members", label: "Members", group: "Organisation", capability: "members:read" },
  { href: "/invitations", label: "Invitations", group: "Organisation", capability: "invitations:read" },
  { href: "/consent", label: "Consent & do-not-call", group: "Organisation", capability: "config:read" },
  { href: "/audit", label: "Audit log", group: "Organisation", capability: "calls:read" },
];

export const allowedDestinations = (capabilities: readonly string[]): readonly Destination[] =>
  DESTINATIONS.filter((d) => d.capability === undefined || capabilities.includes(d.capability));
