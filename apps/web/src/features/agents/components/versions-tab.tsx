"use client";

import { useActionState, useState } from "react";

import { Button, Notice, Panel, Stack, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { when } from "@/lib/format";

import { getDiff, rollback, type DiffResult, type RollbackState } from "../agents.actions";

const START: RollbackState = idleForm();

export interface VersionRow {
  readonly version: number;
  readonly note: string | null;
  readonly publishedBy: string;
  readonly publishedAt: string;
  /** Whether this version answered as a graph or a list. */
  readonly shape: "form" | "flow";
}

type Diff = Extract<DiffResult, { readonly ok: true }>["diff"];

/**
 * One publish is one snapshot, and the API never rewrites history.
 *
 * Restore loads the old snapshot into the unpublished draft. It used to publish it outright,
 * which made this list a second way to change what a caller hears without pressing Publish —
 * the exact thing drafts were added to stop. So "Restore" here means "put version 4 back on
 * my screen", and it is still one deliberate act that makes it real.
 *
 * No `<form>` here either, for the same reason as `TestCallCard`: this panel lives inside
 * the workspace's one publish `<form>`, and a nested `<form>` is invalid HTML. Restoring and
 * diffing both call their Server Action directly from a button.
 */
export const VersionsTab = ({
  agentId,
  versions,
  liveVersion,
  liveShape,
  liveBranches,
}: {
  /** Whose history this is. Versions number per agent, so two agents both have a version 3. */
  readonly agentId: string;
  readonly versions: readonly VersionRow[];
  readonly liveVersion: number;
  /**
   * How the agent is built now, and how many branches its flow has.
   *
   * A restore across the line — a form version onto a flow agent, or the reverse — is a
   * change of authoring model, not a change of wording, and it asks first. Going back to a
   * form is the destructive direction: the confirmation counts what it removes.
   */
  readonly liveShape: "form" | "flow";
  readonly liveBranches: number;
}) => {
  const [state, dispatch, pending] = useActionState(rollback, START);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  /** A cross-shape restore somebody has pressed once and not yet confirmed. */
  const [crossing, setCrossing] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ readonly against: number; readonly result: Diff } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const restore = (version: number) => {
    setCrossing(null);
    setBusyVersion(version);
    const form = new FormData();
    form.set("agentId", agentId);
    form.set("version", String(version));
    dispatch(form);
  };

  /** Restoring this version changes which editor the agent is built in. */
  const crossesTheLine = (v: VersionRow): boolean => v.shape !== liveShape;

  const viewDiff = async (version: number) => {
    setDiffError(null);
    setDiff(null);
    const outcome = await getDiff(agentId, version, liveVersion);
    if (outcome.ok) setDiff({ against: version, result: outcome.diff });
    else setDiffError(outcome.message);
  };

  return (
    <Stack>
      <p className="text-[13.5px] text-[var(--ink-2)]">
        Every publish is a snapshot. A call records which version answered it, so a
        conversation from three weeks ago can still be explained.
      </p>

      {(state.status === "failed" || state.status === "invalid") && state.message !== null && (
        <Notice tone="error">{state.message}</Notice>
      )}
      {/* Not "restored as version N". Nothing was published: the old configuration is now
          sitting in the draft, and it answers a call only when somebody publishes it. Saying
          otherwise would be the same lie the Save buttons used to tell. */}
      {state.status === "succeeded" && (
        <Notice tone="ok">
          Version {state.data?.restoredFrom} is loaded into your unpublished changes. Nothing
          has changed for callers yet — review it and publish when you are ready.
        </Notice>
      )}

      <Panel>
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>Built as</Th>
              <Th>Published</Th>
              <Th>By</Th>
              <Th>Note</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <Tr key={v.version}>
                <Td className="font-mono font-medium">
                  v{v.version} {v.version === liveVersion && <span className="ml-1 text-[11px] text-[var(--ok)]">live</span>}
                </Td>
                <Td>
                  {/* Named on every row once an agent has been converted, because that is when
                      a restore can cross the line — and the only warning that works is the one
                      that is visible before the button is pressed. */}
                  <Tag tone={v.shape === "flow" ? "accent" : "neutral"}>{v.shape === "flow" ? "a flow" : "a form"}</Tag>
                </Td>
                <Td className="text-[var(--ink-3)]">{when(v.publishedAt)}</Td>
                <Td className="text-[var(--ink-3)]">{v.publishedBy}</Td>
                <Td>{v.note ?? "—"}</Td>
                <Td className="text-right whitespace-nowrap">
                  {v.version !== liveVersion && (
                    <Button size="sm" onClick={() => void viewDiff(v.version)} className="mr-1.5">
                      Diff vs live
                    </Button>
                  )}
                  {v.version !== liveVersion && !crossesTheLine(v) && (
                    <Button size="sm" onClick={() => restore(v.version)} disabled={pending && busyVersion === v.version}>
                      {pending && busyVersion === v.version ? "Restoring…" : "Restore"}
                    </Button>
                  )}
                  {v.version !== liveVersion && crossesTheLine(v) && crossing !== v.version && (
                    <Button size="sm" onClick={() => setCrossing(v.version)} disabled={pending}>
                      Restore…
                    </Button>
                  )}
                  {v.version !== liveVersion && crossesTheLine(v) && crossing === v.version && (
                    <span className="inline-flex items-center gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setCrossing(null)}>
                        Keep
                      </Button>
                      <Button
                        size="sm"
                        variant={v.shape === "form" ? "danger" : "secondary"}
                        onClick={() => restore(v.version)}
                        disabled={pending && busyVersion === v.version}
                      >
                        {pending && busyVersion === v.version ? "Restoring…" : v.shape === "form" ? "Yes, back to a form" : "Yes, as a flow"}
                      </Button>
                    </span>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
        {crossing !== null && (
          <p className="border-t border-[var(--hairline)] px-[18px] py-3 text-[12.5px] text-[var(--ink-2)]">
            {versions.find((v) => v.version === crossing)?.shape === "form"
              ? liveBranches === 0
                ? `Version ${crossing} was built as a form. Restoring it takes this agent back to a form; its flow has no branches, so nothing is lost. The canvas stays on the agent.`
                : `Version ${crossing} was built as a form. Restoring it takes this agent back to a form and removes ${liveBranches} ${liveBranches === 1 ? "branch" : "branches"}. Every question is kept; the canvas stays on the agent in case you change your mind.`
              : `Version ${crossing} was built as a flow. Restoring it puts that flow on the canvas and this agent back on it. Nothing is lost.`}
          </p>
        )}
      </Panel>

      {diffError !== null && <Notice tone="error">{diffError}</Notice>}

      {diff !== null && (
        <Panel>
          <div className="p-4">
            <h4 className="mb-2 text-[13px] font-semibold">
              v{diff.against} → v{liveVersion}
            </h4>
            {diff.result.identical ? (
              <p className="text-[13px] text-[var(--ink-3)]">Identical.</p>
            ) : (
              <table className="w-full border-collapse text-[13px]">
                <tbody>
                  {diff.result.fields.map((f) => (
                    <tr key={f.field} className="border-b border-[var(--surface-line)] last:border-b-0">
                      <td className="py-1.5 pr-3 font-mono text-[12px] text-[var(--ink-3)]">{f.field}</td>
                      <td className="py-1.5 pr-3 text-[var(--bad)] line-through">{f.before ?? "—"}</td>
                      <td className="py-1.5 text-[var(--ok)]">{f.after ?? "—"}</td>
                    </tr>
                  ))}
                  {diff.result.flow.shape.before !== diff.result.flow.shape.after && (
                    <tr className="border-b border-[var(--surface-line)]">
                      <td className="py-1.5 pr-3 font-mono text-[12px] text-[var(--ink-3)]">built as</td>
                      <td className="py-1.5 pr-3 text-[var(--bad)] line-through">{diff.result.flow.shape.before === "flow" ? "a flow" : "a form"}</td>
                      <td className="py-1.5 text-[var(--ok)]">{diff.result.flow.shape.after === "flow" ? "a flow" : "a form"}</td>
                    </tr>
                  )}
                  {/* The graph, when it moved. A rewiring leaves every question in place and
                      the field rows above say nothing, so this is where "the deposit question
                      now goes to buyers instead of renters" is visible at all. */}
                  {(["added", "removed", "changed"] as const).map((what) =>
                    diff.result.flow.steps[what].length === 0 ? null : (
                      <tr key={`steps-${what}`} className="border-b border-[var(--surface-line)]">
                        <td className="py-1.5 pr-3 font-mono text-[12px] text-[var(--ink-3)]">steps {what}</td>
                        <td className="py-1.5 pr-3 text-[var(--bad)]">{what === "removed" ? diff.result.flow.steps[what].join("; ") : "—"}</td>
                        <td className="py-1.5 text-[var(--ok)]">{what === "removed" ? "—" : diff.result.flow.steps[what].join("; ")}</td>
                      </tr>
                    ),
                  )}
                  {(diff.result.flow.connections.added.length > 0 || diff.result.flow.connections.removed.length > 0) && (
                    <tr className="border-b border-[var(--surface-line)]">
                      <td className="py-1.5 pr-3 font-mono text-[12px] text-[var(--ink-3)]">connections</td>
                      <td className="py-1.5 pr-3 text-[var(--bad)]">{diff.result.flow.connections.removed.join("; ") || "—"}</td>
                      <td className="py-1.5 text-[var(--ok)]">{diff.result.flow.connections.added.join("; ") || "—"}</td>
                    </tr>
                  )}
                  {(diff.result.keyterms.added.length > 0 || diff.result.keyterms.removed.length > 0) && (
                    <tr>
                      <td className="py-1.5 pr-3 font-mono text-[12px] text-[var(--ink-3)]">keyterms</td>
                      <td className="py-1.5 pr-3 text-[var(--bad)]">{diff.result.keyterms.removed.join(", ") || "—"}</td>
                      <td className="py-1.5 text-[var(--ok)]">{diff.result.keyterms.added.join(", ") || "—"}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </Panel>
      )}
    </Stack>
  );
};
