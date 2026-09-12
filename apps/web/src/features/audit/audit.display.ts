/**
 * An audit row as a sentence.
 *
 * The API stores a slug and a few details; a person reads "Vera published version 4 of
 * Front desk". The actor is rendered separately (initials and name), so these are the
 * predicate only: what was done, to what. Unknown actors — rows backfilled from tables that
 * never recorded one — read the same, with "Somebody" where the name would be.
 */

interface Row {
  readonly action: string;
  readonly subjectLabel: string | null;
  readonly detail: Readonly<Record<string, string | null>>;
}

export type AuditTone = "neutral" | "ok" | "warn" | "bad" | "accent";

export interface AuditLine {
  readonly text: string;
  readonly tone: AuditTone;
}

const who = (row: Row): string => row.subjectLabel ?? "somebody";
const what = (row: Row, fallback: string): string => row.subjectLabel ?? fallback;

export const describeAudit = (row: Row): AuditLine => {
  const d = row.detail;
  switch (row.action) {
    case "signed_in":
      return { text: "signed in", tone: "neutral" };
    case "signed_out":
      return { text: "signed out", tone: "neutral" };
    case "password_changed":
      return {
        text: d["otherSessionsEnded"] === undefined || d["otherSessionsEnded"] === "0"
          ? "changed their password"
          : `changed their password and signed out ${d["otherSessionsEnded"]} other session${d["otherSessionsEnded"] === "1" ? "" : "s"}`,
        tone: "accent",
      };
    case "account_closed":
      return { text: "closed their account", tone: "bad" };
    case "member_invited":
      return { text: `invited ${who(row)}${d["role"] ? ` as ${d["role"]}` : ""}`, tone: "ok" };
    case "invitation_accepted":
      return { text: `joined${d["role"] ? ` as ${d["role"]}` : ""} (${what(row, "an invitation")})`, tone: "ok" };
    case "invitation_revoked":
      return { text: `revoked the invitation to ${who(row)}`, tone: "warn" };
    case "member_role_changed":
      return { text: `made ${who(row)} ${d["role"] ?? "a different role"}`, tone: "accent" };
    case "member_removed":
      return { text: `removed ${who(row)}`, tone: "bad" };
    case "access_revoked":
      return { text: `revoked ${who(row)}'s access`, tone: "warn" };
    case "access_restored":
      return { text: `restored ${who(row)}'s access`, tone: "ok" };
    case "agent_created":
      return { text: `created the agent ${what(row, "")}`.trim(), tone: "ok" };
    case "agent_retired":
      return { text: `retired the agent ${what(row, "")}`.trim(), tone: "bad" };
    case "agent_published":
      return {
        text: `published${d["version"] ? ` version ${d["version"]}` : ""} of ${what(row, "an agent")}${d["note"] ? ` — “${d["note"]}”` : ""}`,
        tone: "accent",
      };
    case "agent_rolled_back":
      return { text: `rolled ${what(row, "an agent")} back to version ${d["version"] ?? "?"}`, tone: "warn" };
    case "recording_listened":
      return { text: `listened to the recording of a call${row.subjectLabel ? ` with ${row.subjectLabel}` : ""}`, tone: "neutral" };
    case "do_not_call_added":
      return { text: `put ${what(row, d["phone"] ?? "a number")} on the do-not-call list`, tone: "warn" };
    case "organisation_renamed":
      return { text: `renamed the organisation${d["from"] ? ` from ${d["from"]}` : ""} to ${d["to"] ?? what(row, "")}`, tone: "accent" };
    case "recording_turned_on":
      return { text: "turned call recording on", tone: "warn" };
    case "recording_turned_off":
      return { text: "turned call recording off", tone: "neutral" };
    case "hours_changed":
      return {
        text: d["hours"] === "always open" ? "set the hours to always open" : `set the hours to ${d["hours"] ?? "new times"}${d["closedDates"] && d["closedDates"] !== "0" ? ` with ${d["closedDates"]} closed date${d["closedDates"] === "1" ? "" : "s"}` : ""}`,
        tone: "accent",
      };
    case "credential_saved":
      return { text: `saved the credential ${what(row, "")}`.trim(), tone: "accent" };
    case "credential_removed":
      return { text: `removed the credential ${what(row, "")}`.trim(), tone: "bad" };
    case "webhooks_saved":
      return { text: `saved the webhook settings${d["receivers"] ? ` (${d["receivers"]} receiver${d["receivers"] === "1" ? "" : "s"})` : ""}`, tone: "accent" };
    default:
      return { text: row.action.replace(/_/g, " "), tone: "neutral" };
  }
};

/** Where the subject can be opened, when it still can be. */
export const subjectHref = (row: { readonly subjectKind: string | null; readonly subjectId: string | null }): string | null => {
  if (row.subjectId === null) return null;
  switch (row.subjectKind) {
    case "agent":
      return `/agents/${row.subjectId}`;
    case "call":
      return `/calls/${row.subjectId}`;
    case "contact":
      return `/contacts/${row.subjectId}`;
    case "member":
    case "invitation":
      return "/organisation?s=people";
    default:
      return null;
  }
};

export const KIND_LABELS: Readonly<Record<string, string>> = {
  people: "People",
  agents: "Agents",
  calls: "Calls",
  organisation: "Organisation",
  security: "Sign-ins & accounts",
};

const KIND_OF_ACTION: Readonly<Record<string, string>> = {
  signed_in: "security", signed_out: "security", password_changed: "security", account_closed: "security",
  member_invited: "people", invitation_accepted: "people", invitation_revoked: "people", member_role_changed: "people",
  member_removed: "people", access_revoked: "people", access_restored: "people",
  agent_created: "agents", agent_retired: "agents", agent_published: "agents", agent_rolled_back: "agents",
  recording_listened: "calls", do_not_call_added: "calls",
  organisation_renamed: "organisation", recording_turned_on: "organisation", recording_turned_off: "organisation",
  hours_changed: "organisation", credential_saved: "organisation", credential_removed: "organisation", webhooks_saved: "organisation",
};

/** The bucket an action belongs to, as the filter chips name it. */
export const kindLabelOf = (action: string): string => {
  const kind = KIND_OF_ACTION[action];
  return kind === undefined ? action.split("_")[0] ?? action : (KIND_LABELS[kind] ?? kind);
};
