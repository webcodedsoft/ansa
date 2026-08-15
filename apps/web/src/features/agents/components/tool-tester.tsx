"use client";

import { useActionState } from "react";

import { Card, Notice, SelectField, Stack, SubmitButton, Tag, TextAreaField, type Tone } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { testToolAction, type ToolTestResult, type ToolTestState } from "../agents.actions";

const START: ToolTestState = idleForm();

const OUTCOME_TONE: Record<ToolTestResult["outcome"], Tone> = {
  ok: "ok",
  confirm: "warn",
  transfer: "bad",
  failed: "bad",
};

/**
 * Run a registered tool through the real dispatch path with test arguments.
 *
 * `POST /tools/{name}/test` applies the same risk tier a call would: a `write` tool answers
 * `confirm` and does not fire, an `irreversible` one answers `transfer` and never runs. This
 * is where a speech template that silently renders its fallback becomes visible, which is
 * why the raw response and the normalized speech are both shown rather than just "success".
 */
export const ToolTester = ({ names }: { readonly names: readonly string[] }) => {
  const [state, action, pending] = useActionState(testToolAction, START);

  return (
    <Card title="Test a tool" description="Runs through the same dispatch path a call uses. Risk tiers apply.">
      <form action={action}>
        <Stack>
          <SelectField label="Tool" name="name" error={state.fieldErrors["name"]} disabled={names.length === 0}>
            {names.length === 0 ? (
              <option value="">No tools registered</option>
            ) : (
              names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))
            )}
          </SelectField>
          <TextAreaField
            label="Arguments"
            name="argumentsJson"
            defaultValue="{}"
            className="font-mono"
            error={state.fieldErrors["argumentsJson"]}
            hint="JSON, matching the tool's parametersJson."
          />
          <div>
            <SubmitButton pending={pending} idle="Run" busy="Running…" />
          </div>

          {(state.status === "failed" || state.status === "invalid") && state.message !== null && (
            <Notice tone="error">{state.message}</Notice>
          )}

          {state.status === "succeeded" && state.data !== null && (
            <div className="rounded-lg border border-[var(--hairline)] p-3.5">
              <div className="mb-2 flex items-center gap-2">
                <Tag tone={OUTCOME_TONE[state.data.outcome]}>{state.data.outcome}</Tag>
                <span className="text-xs text-[var(--ink-3)]">{state.data.latencyMs} ms</span>
              </div>
              <p className="text-[13px]">{state.data.summary}</p>
              <p className="mt-1.5 text-[13px] text-[var(--ink-2)] italic">“{state.data.speech}”</p>
              {state.data.raw !== null && (
                <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--surface-2)] p-2.5 font-mono text-[11.5px]">{state.data.raw}</pre>
              )}
            </div>
          )}
        </Stack>
      </form>
    </Card>
  );
};
