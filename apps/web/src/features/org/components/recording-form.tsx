"use client";

import { Mic } from "lucide-react";
import { useActionState, useState } from "react";

import { Card, Notice, SubmitButton, Tag } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { saveRecording, type RecordingState } from "../org.actions";

const START: RecordingState = idleForm();

/**
 * Whether this organisation records its calls.
 *
 * The switch and the disclosure are one thing. `record_calls` (migration 0077) is read by the
 * call path, and when it is on the agent's opening line gains "This call is recorded" — there
 * is no way to record without saying so, which is why the form shows the sentence a caller
 * will hear rather than describing it. Applied immediately, like hours: there is no version
 * for it to sit in.
 */
export const RecordingForm = ({
  organisationName,
  recordCalls,
}: {
  readonly organisationName: string;
  readonly recordCalls: boolean;
}) => {
  const [state, action, pending] = useActionState(saveRecording, START);
  const [on, setOn] = useState(recordCalls);
  const current = state.data?.recordCalls ?? recordCalls;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Mic aria-hidden className="size-4 text-[var(--ink-3)]" />
          Recording
        </span>
      }
      description="Whether calls are kept as audio. Off by default. When on, every caller is told in the agent's first sentence — the disclosure is not a separate setting."
      actions={<Tag tone={current ? "ok" : "warn"}>{current ? "on" : "off"}</Tag>}
    >
      <form action={action} className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && <Notice tone="ok">{state.message}</Notice>}

        <label className="flex cursor-pointer items-center gap-3.5 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3.5 py-3">
          <input
            id="record-calls"
            type="checkbox"
            name="recordCalls"
            checked={on}
            onChange={(event) => setOn(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative h-[22px] w-[38px] flex-none rounded-full bg-[var(--hairline)] transition-colors peer-checked:bg-[var(--accent)] after:absolute after:top-[2px] after:left-[2px] after:size-[18px] after:rounded-full after:bg-[var(--surface-solid)] after:shadow-[var(--shadow-s)] after:transition-transform peer-checked:after:translate-x-4"
          />
          <span className="min-w-0">
            <span className="block text-[14px] font-medium">Record calls</span>
            <span className="block text-[12.5px] text-[var(--ink-3)]">
              Both sides, mixed to stereo — the caller on the left, the agent on the right.
            </span>
          </span>
        </label>

        <div>
          <div className="mb-1.5 text-[12.5px] font-medium">What callers will hear</div>
          <p className="m-0 rounded-lg border border-dashed border-[var(--hairline)] px-3.5 py-3 text-[13.5px] text-[var(--ink-2)] italic">
            &ldquo;Thank you for calling {organisationName}.{" "}
            {on ? (
              <strong className="not-italic text-[var(--ink)]">This call is recorded. </strong>
            ) : null}
            How can I help you?&rdquo;
          </p>
        </div>

        <dl className="m-0 grid grid-cols-[10rem_minmax(0,1fr)] gap-x-3.5 gap-y-1.5 text-[13px]">
          <dt className="text-[var(--ink-3)]">Who has listened</dt>
          <dd className="m-0">Every play of a recording is logged against a name.</dd>
          <dt className="text-[var(--ink-3)]">Kept for</dt>
          <dd className="m-0">As long as the audio retention window, then deleted.</dd>
        </dl>

        <div>
          <SubmitButton pending={pending} idle="Save" />
        </div>
      </form>
    </Card>
  );
};
