"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import {
  Button,
  EmptyState,
  Notice,
  Panel,
  PanelBody,
  SectionHead,
  Stack,
  Tag,
  Toggle,
  type Tone,
} from "@/components/ui";

import { saveAgentTools } from "../agents.actions";
import type { AgentSummary, ToolsDocument } from "../agents.service";

/**
 * Which of the organisation's tools this agent may call.
 *
 * The registry is defined once for the organisation — endpoints, risk tiers, the egress
 * allowlist, the credential references — and this is one agent's slice of it. That split is
 * the point: two agents can share an endpoint's URL and credential without sharing
 * permission to use it, and an after-hours line that only takes messages has no business
 * reaching the endpoint that cancels a policy.
 *
 * Nothing here edits the registry. Adding an endpoint, changing its tier or pointing it
 * somewhere else all happen once, in the registry, because doing them per agent would mean
 * maintaining the same SSRF allowlist in as many places as there are agents.
 */

const TIER_TONE: Record<"read" | "write" | "irreversible", Tone> = {
  read: "ok",
  write: "warn",
  irreversible: "bad",
};

/**
 * What each tier actually does, in the words of the code that enforces it.
 *
 * Beside every tool rather than explained once at the top, because the tier is the whole
 * decision being made on this screen. Switching on a `write` tool is agreeing to a spoken
 * readback before it fires; switching on an `irreversible` one is agreeing that it never
 * fires at all. Those are different promises, and neither is obvious from a coloured word.
 */
const TIER_NOTE: Record<"read" | "write" | "irreversible", string> = {
  read: "Runs as soon as the agent asks for it.",
  write: "Only after the agent has read the value back and the caller has agreed.",
  irreversible: "Never runs on a call — the agent transfers to a person instead.",
};

interface Entry {
  readonly name: string;
  readonly description: string | null;
  readonly route: string;
  readonly riskTier: "read" | "write" | "irreversible";
  readonly credentialRef: string | null;
  /** Call facts the tool is sent, by the name the registry gives them. */
  readonly needs: readonly string[];
}

/**
 * The two facts an agent can produce without being configured to collect anything.
 *
 * A caller who volunteers their name or a policy number has it captured reactively, so a
 * tool naming either resolves on an agent with no form at all. Nothing else does: every
 * other fact reaches a tool only because a field on the Data captured tab put it there.
 * `customerId` is deliberately absent — the fact store has a slot for it and no path that
 * fills one, so a tool asking for it gets nothing unless a field is keyed `customerId`.
 */
const WITHOUT_A_FIELD: ReadonlySet<string> = new Set(["callerName", "policyNumber"]);

/** The host, not the URL: a path can carry an identifier, and this is a list somebody reads. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    // A malformed URL is the registry's problem to report, not this screen's to crash on.
    return url;
  }
};

/** Every tool the organisation's registry holds, flat, however it is reached. */
export const registryTools = (tools: ToolsDocument): readonly Entry[] => [
  ...tools.http.map((tool) => ({
    name: tool.name,
    description: tool.description,
    route: `HTTP · ${hostOf(tool.url)}`,
    riskTier: tool.riskTier,
    credentialRef: tool.credentialRef ?? null,
    needs: (tool.identifiers ?? []).map((identifier) => identifier.fact),
  })),
  ...tools.mcp.flatMap((server) =>
    server.tools.map((tool) => ({
      name: tool.name,
      // An MCP policy carries no description of its own — the server supplies one at
      // handshake, which has not happened here. Saying nothing beats inventing something.
      description: null,
      route: `MCP · ${hostOf(server.url)}`,
      riskTier: tool.riskTier,
      credentialRef: server.credentialRef ?? null,
      needs: (tool.identifiers ?? []).map((identifier) => identifier.fact),
    })),
  ),
];

/** Joined the way somebody reads it out, not the way an array prints. */
const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

export const ToolsTab = ({
  agent,
  tools,
}: {
  readonly agent: AgentSummary;
  readonly tools: ToolsDocument;
}) => {
  const entries = registryTools(tools);

  /* What this agent can actually hand a tool. A dispatch that cannot resolve an identifier
     answers `unconfirmed-identity` and the tool does not run — correct, and invisible:
     nothing on this screen said so, and the only way to find out was to make a call and
     hear the agent say it could not check. */
  const collected = new Set(agent.capturedFields.map((field) => field.key));
  const missingFor = (entry: Entry): readonly string[] =>
    entry.needs.filter((fact) => !collected.has(fact) && !WITHOUT_A_FIELD.has(fact));
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set(agent.enabledTools));
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, startSaving] = useTransition();

  const toggle = (name: string, next: boolean): void => {
    setSaved(false);
    setEnabled((current) => {
      const updated = new Set(current);
      if (next) updated.add(name);
      else updated.delete(name);
      return updated;
    });
  };

  const save = (): void => {
    setFailure(null);
    startSaving(async () => {
      const result = await saveAgentTools(agent.agentId, [...enabled]);
      if (result.ok) setSaved(true);
      else setFailure(result.message);
    });
  };

  /* Names this agent selects that the registry no longer holds. Not an error — a tool can
     be removed after an agent selected it — but worth showing, because the row it used to
     have is gone and the stale selection would otherwise stay invisible until dispatch
     refused it mid-call. */
  const known = new Set(entries.map((entry) => entry.name));
  const orphaned = [...enabled].filter((name) => !known.has(name));

  /* Only the enabled ones are raised to a notice. A registry tool nobody switched on and
     cannot feed is not this agent's problem, and warning about it would put a banner on
     every screen in the organisation. */
  const starved = entries
    .filter((entry) => enabled.has(entry.name) && missingFor(entry).length > 0)
    .map((entry) => entry.name);

  if (entries.length === 0) {
    return (
      <Panel>
        <EmptyState
          title="No tools registered"
          action={
            <Link href="/tools" className="text-sm font-medium text-[var(--accent)] hover:underline">
              Open the registry
            </Link>
          }
        >
          This organisation has not connected an HTTP endpoint or an MCP server yet. Until it
          does, the agent says it cannot look anything up — which is the honest answer, and
          better than a guess.
        </EmptyState>
      </Panel>
    );
  }

  return (
    <Stack>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[17px] font-semibold tracking-[-0.018em]">
            What this agent may call
          </h2>
          <p className="mt-1 max-w-[64ch] text-[13.5px] text-[var(--ink-3)]">
            {enabled.size} of {entries.length} enabled. The registry belongs to the
            organisation; this is what this agent is allowed to reach. A new agent starts
            with nothing selected, because inheriting another agent&rsquo;s permissions is
            not a safe default.
          </p>
        </div>
        <div className="flex flex-none items-center gap-2">
          {saved && !saving && <Tag tone="ok">Saved</Tag>}
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save selection"}
          </Button>
        </div>
      </div>

      {failure !== null && <Notice tone="error">{failure}</Notice>}

      {orphaned.length > 0 && (
        <Notice tone="warn">
          This agent still selects {orphaned.join(", ")}, which the registry no longer holds.
          Reaching for {orphaned.length === 1 ? "it" : "them"} fails the same way an
          unregistered tool does, so nothing unsafe happens — but the selection is doing
          nothing. Saving now drops {orphaned.length === 1 ? "it" : "them"}.
        </Notice>
      )}

      {starved.length > 0 && (
        <Notice tone="warn">
          {listed(starved)} {starved.length === 1 ? "is" : "are"} enabled and{" "}
          {starved.length === 1 ? "needs" : "need"} a value this agent never collects.
          Nothing unsafe happens — dispatch refuses an identifier it cannot resolve — but the
          tool will not run on any call, and the caller hears the agent say it cannot check.
          Each row below names the field it is waiting for.
        </Notice>
      )}

      <Panel>
        <div className="divide-y divide-[var(--surface-line)]">
          {entries.map((entry) => (
            <div
              key={`${entry.route}:${entry.name}`}
              className="flex items-start gap-4 px-[18px] py-3.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-semibold">{entry.name}</span>
                  <Tag tone={TIER_TONE[entry.riskTier]}>{entry.riskTier}</Tag>
                  {entry.credentialRef !== null && (
                    <Tag>
                      <span className="font-mono text-[11px]">{entry.credentialRef}</span>
                    </Tag>
                  )}
                </div>
                {entry.description !== null && entry.description !== "" && (
                  <p className="mt-1 text-[12.5px] text-[var(--ink-2)]">{entry.description}</p>
                )}
                <p className="mt-1 text-[12.5px] text-[var(--ink-3)]">
                  {TIER_NOTE[entry.riskTier]}
                </p>
                {missingFor(entry).length > 0 && (
                  <p className="mt-1 text-[12.5px] text-[var(--warn)]">
                    Needs {listed(missingFor(entry))}, which this agent never collects. It
                    refuses rather than guessing, so the caller hears that it cannot check
                    — add {missingFor(entry).length === 1 ? "a field" : "fields"} under Data
                    captured, keyed exactly {listed(missingFor(entry))}.
                  </p>
                )}
                <p className="mt-1 font-mono text-[11px] text-[var(--ink-3)]">{entry.route}</p>
              </div>
              <div className="flex-none pt-1">
                <Toggle
                  checked={enabled.has(entry.name)}
                  label={`${entry.name} enabled for this agent`}
                  onChange={(next) => toggle(entry.name, next)}
                />
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <SectionHead>The registry</SectionHead>
      <Panel>
        <PanelBody>
          <p className="max-w-[70ch] text-[13px] text-[var(--ink-2)]">
            Endpoints, risk tiers, the hosts an agent may be pointed at and the credentials
            that open them are defined once for the organisation. Editing them here would
            mean maintaining the same allowlist in as many places as there are agents.
          </p>
          <Link
            href="/tools"
            className="mt-3 inline-block text-sm font-medium text-[var(--accent)] hover:underline"
          >
            Open the registry →
          </Link>
        </PanelBody>
      </Panel>
    </Stack>
  );
};
