"use client";

import { useActionState, useState } from "react";

import { Button, Notice, Panel, Stack, Table, Td, Th, Tr } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { when } from "@/lib/format";

import { getDiff, rollback, type DiffResult, type RollbackState } from "../agents.actions";

const START: RollbackState = idleForm();

export interface VersionRow {
  readonly version: number;
  readonly note: string | null;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

type Diff = Extract<DiffResult, { readonly ok: true }>["diff"];

/**
 * One publish is one snapshot. Restoring an old one publishes a *new* version with that
 * snapshot's content — the API never rewrites history — so "Restore" here is really
 * "publish this again", which is why it goes through the same `rollback` action rather
 * than editing anything in place.
 *
 * No `<form>` here either, for the same reason as `TestCallCard`: this panel lives inside
 * the workspace's one publish `<form>`, and a nested `<form>` is invalid HTML. Restoring and
 * diffing both call their Server Action directly from a button.
 */
export const VersionsTab = ({ versions, liveVersion }: { readonly versions: readonly VersionRow[]; readonly liveVersion: number }) => {
  const [state, dispatch, pending] = useActionState(rollback, START);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const [diff, setDiff] = useState<{ readonly against: number; readonly result: Diff } | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const restore = (version: number) => {
    setBusyVersion(version);
    const form = new FormData();
    form.set("version", String(version));
    dispatch(form);
  };

  const viewDiff = async (version: number) => {
    setDiffError(null);
    setDiff(null);
    const outcome = await getDiff(version, liveVersion);
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
      {state.status === "succeeded" && <Notice tone="ok">Restored as version {state.data?.version}.</Notice>}

      <Panel>
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
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
                <Td className="text-[var(--ink-3)]">{when(v.publishedAt)}</Td>
                <Td className="text-[var(--ink-3)]">{v.publishedBy}</Td>
                <Td>{v.note ?? "—"}</Td>
                <Td className="text-right whitespace-nowrap">
                  {v.version !== liveVersion && (
                    <Button size="sm" onClick={() => void viewDiff(v.version)} className="mr-1.5">
                      Diff vs live
                    </Button>
                  )}
                  {v.version !== liveVersion && (
                    <Button size="sm" onClick={() => restore(v.version)} disabled={pending && busyVersion === v.version}>
                      {pending && busyVersion === v.version ? "Restoring…" : "Restore"}
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
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
