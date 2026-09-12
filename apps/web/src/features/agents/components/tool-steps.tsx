"use client";

import { useActionState, useEffect, useMemo, type ReactNode } from "react";

import { Button, Card, Notice, Stack, Tag, TextAreaField, type Tone } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFailureToast } from "@/stores/toast.store";

import { sampleEndpointAction, tryToolAction, type SampleState, type ToolTestState } from "../agents.actions";
import { fieldsIn, toApiTool, type HttpToolDraft } from "../http-tool.schema";
import type { ResponseField } from "./speech-template-field";

/**
 * The two steps of the tool builder that talk to the organisation's own server: fetching a
 * sample response, and running the tool as it stands. Shared by the registry's builder and
 * the add-a-tool dialog, which is why they are here rather than inside either.
 */

type Frame = "card" | "plain";

/** A Card on the page; on a dialog that already frames its step, just the content. */
const Framed = ({
  frame,
  title,
  description,
  children,
}: {
  readonly frame: Frame;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
}) =>
  frame === "card" ? (
    <Card title={title} description={description}>
      {children}
    </Card>
  ) : (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-[var(--ink-2)]">{description}</p>
      {children}
    </div>
  );

const SECTION = "text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]";

/**
 * Fetch one real response, and turn it into the list of paths a template may name.
 *
 * A GET only, and the API refuses anything else. A "sample" of a POST would perform whatever
 * that POST does, and finding out what a cancellation endpoint returns by cancelling
 * something is not a preview. For those the tier is the answer: save, then use the test
 * step, where a write answers `confirm` without firing.
 */
export const SampleStep = ({
  draft,
  onFields,
  found,
  frame = "card",
}: {
  readonly draft: HttpToolDraft;
  readonly onFields: (fields: readonly ResponseField[]) => void;
  readonly found: readonly ResponseField[];
  /** `card` on the registry page; `plain` inside a dialog that frames the step itself. */
  readonly frame?: Frame;
}) => {
  const [state, action, pending] = useActionState(sampleEndpointAction, idleForm() as SampleState);
  /* A refused fetch used to show nothing at all: the button un-spun and the page stayed as
     it was, which reads as "the button does nothing". Every failure is a toast. */
  useFailureToast(state);

  /* Bound once. `FormState` is not a discriminated union, so checking `status` does not
     narrow `data`, and reading it in four places would mean four non-null assertions. */
  const seen = state.status === "succeeded" ? state.data : null;

  const parsed = useMemo(() => {
    if (seen?.json == null) return null;
    try {
      return JSON.parse(seen.json) as unknown;
    } catch {
      return null;
    }
  }, [seen]);

  // Lifted to the parent so the next step can offer them. An effect rather than a render-time
  // call: setting a parent's state while rendering a child is the React warning nobody reads.
  useEffect(() => {
    if (parsed !== null) onFields(fieldsIn(parsed));
  }, [parsed, onFields]);

  const headers = JSON.stringify(
    Object.fromEntries(
      draft.headers
        .filter((header) => header.name.trim() !== "")
        .map((header) => [header.name, header.value]),
    ),
  );

  return (
    <Framed
      frame={frame}
      title="See what it returns"
      description="So the sentence in the next step is written against something real."
    >
      <Stack>
        <p className="max-w-[70ch] text-[13px] text-[var(--ink-2)]">
          A template naming a field the response does not have renders the no-record sentence
          instead. On a call that is indistinguishable from the customer genuinely having no
          record, which is why this is a step rather than optional polish.
        </p>

        <form action={action}>
          <input type="hidden" name="url" value={draft.url} />
          <input type="hidden" name="credentialRef" value={draft.credentialRef} />
          <input type="hidden" name="headers" value={headers} />
          <Stack>
            <div className="overflow-x-auto rounded-lg border border-[var(--surface-line)] bg-[var(--surface-2)] px-3 py-2 font-mono text-[12px] text-[var(--ink-2)]">
              GET {draft.url === "" ? "—" : draft.url}
            </div>
            {draft.method !== "GET" && (
              <Notice tone="warn">
                This tool is a {draft.method}. The sample is always a GET, because performing a{" "}
                {draft.method} to see what it returns would do whatever that {draft.method} does.
                Save the tool and use the test step instead &mdash; the risk tier applies there.
              </Notice>
            )}
            <div>
              <Button pending={pending} type="submit" disabled={pending || draft.url === ""}>
                Fetch a sample
              </Button>
            </div>
          </Stack>
        </form>


        {seen !== null && (
          <>
            <p className="text-[13px] text-[var(--ink-2)]">
              Answered <span className="font-mono">{seen.status}</span>.
              {seen.detail !== null && <> {seen.detail}</>}
            </p>
            {parsed !== null && (
              <pre className="max-h-72 overflow-auto rounded-lg border border-[var(--surface-line)] bg-[var(--surface-2)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--ink-2)]">
                {JSON.stringify(parsed, null, 2)}
              </pre>
            )}
          </>
        )}

        {found.length > 0 && (
          <div>
            <span className={SECTION}>Fields you can speak</span>
            <p className="mt-1 text-[12px] text-[var(--ink-3)]">
              Carried to the next step, where clicking one adds it to the sentence.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {found.map((field) => (
                <span
                  key={field.path}
                  className="rounded-[4px] border border-[var(--surface-line)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink-2)]"
                >
                  {field.path}
                  <span className="ml-1.5 text-[var(--ink-3)]">{field.sample}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Stack>
    </Framed>
  );
};

/**
 * Run the tool as it stands, without saving it first.
 *
 * It used to require a save, which meant publishing a configuration version to find out
 * whether the thing worked and another to fix it — so the version history filled with
 * attempts rather than decisions, and every attempt was live on the phone line in between.
 *
 * `POST /tools/try` builds an ephemeral document from this draft and hands it to the same
 * `runToolInSandbox` the saved test uses. One execution route, a different document. The
 * tiers therefore still hold: a write answers `confirm` without firing, an irreversible one
 * answers `transfer` and never runs.
 *
 * Blocked while anything is invalid, because a run against a half-written tool reports the
 * wrong problem — a missing readback comes back as a refusal, and the operator goes looking
 * at their endpoint.
 */
const OUTCOME_TONE: Record<string, Tone> = {
  ok: "ok",
  confirm: "warn",
  transfer: "bad",
  failed: "bad",
};

export const ToolTest = ({
  draft,
  blockers,
  onBlocked,
  frame = "card",
}: {
  readonly frame?: Frame;
  readonly draft: HttpToolDraft;
  /** Everything still wrong with the draft, by the step that can fix it. Empty means it can run. */
  readonly blockers: readonly { readonly step: string; readonly message: string }[];
  /** Pressed Run test while blocked: the caller marks the rail and the fields so the problems can be found. */
  readonly onBlocked: () => void;
}) => {
  const blocked = blockers.length > 0;
  const [state, action, pending] = useActionState(tryToolAction, idleForm() as ToolTestState);
  // Same as the sample fetch above: a refused run has to be seen, not inferred from silence.
  useFailureToast(state);

  const suggested = useMemo(
    () =>
      JSON.stringify(
        Object.fromEntries(
          draft.params
            .filter((param) => param.name.trim() !== "")
            .map((param) => [param.name, param.type === "number" ? 0 : ""]),
        ),
        null,
        2,
      ),
    [draft.params],
  );

  const ran = state.status === "succeeded" ? state.data : null;

  return (
    <Framed
      frame={frame}
      title="Test it"
      description="The same dispatch path a call uses, on the tool as it stands. Nothing is saved."
    >
      <form
        action={(form) => {
          form.set("tool", JSON.stringify(toApiTool(draft)));
          action(form);
        }}
      >
        <Stack>
          {/* Named, not merely counted. This used to say "fix the steps marked in the rail"
              while the rail marked nothing until a save was attempted — so the button sat
              disabled next to four green ticks, and "nothing happens" was the honest report. */}
          {blocked && (
            <Notice tone="warn">
              <span>
                Before it can run, {blockers.length === 1 ? "one thing" : `${blockers.length} things`} still{" "}
                {blockers.length === 1 ? "needs" : "need"} filling in. Running a half-written tool reports
                the wrong problem &mdash; a missing readback comes back as a refusal, and you go looking at your endpoint.
              </span>
              <ul className="mt-1.5 list-disc pl-4">
                {blockers.map((blocker, index) => (
                  <li key={index}>
                    <span className="font-medium">{blocker.step}</span> &mdash; {blocker.message}
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          <TextAreaField
            label="Arguments"
            name="argsJson"
            defaultValue={suggested}
            rows={5}
            className="font-mono text-[12.5px]"
            hint="Stands in for what the model would pass."
          />

          <Notice tone="warn">
            A <span className="font-mono">write</span> tool answers &ldquo;confirm&rdquo; and
            does not fire; an <span className="font-mono">irreversible</span> one answers
            &ldquo;transfer&rdquo; and never runs. That is the tier working, not a failure.
          </Notice>

          <div>
            {/* Never disabled for being blocked: a dead button explains nothing. Pressing it
                marks every step and field that is in the way, which is what the person
                needs in order to go and fix them. */}
            <Button
              pending={pending}
              type={blocked ? "button" : "submit"}
              disabled={pending}
              onClick={blocked ? onBlocked : undefined}
            >
              Run test
            </Button>
          </div>


          {ran !== null && (
            <Stack>
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={OUTCOME_TONE[ran.outcome] ?? "warn"}>{ran.outcome}</Tag>
                <span className="text-[12.5px] tabular-nums text-[var(--ink-3)]">
                  {ran.latencyMs} ms
                </span>
              </div>

              <div>
                <span className={SECTION}>What the caller would hear</span>
                <p className="mt-1.5 rounded-lg border border-[var(--surface-line)] bg-[var(--surface-2)] px-3 py-2 text-[13.5px] text-[var(--ink)]">
                  {ran.speech}
                </p>
              </div>

              {ran.raw !== null && (
                <div>
                  <span className={SECTION}>What the endpoint returned</span>
                  <p className="mt-1 text-[12px] text-[var(--ink-3)]">
                    Beside the sentence on purpose. A template naming a field this does not
                    have renders the no-record line, and nothing else would report that the
                    lookup in fact worked.
                  </p>
                  <pre className="mt-1.5 max-h-64 overflow-auto rounded-lg border border-[var(--surface-line)] bg-[var(--surface-2)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--ink-2)]">
                    {ran.raw}
                  </pre>
                </div>
              )}
            </Stack>
          )}
        </Stack>
      </form>
    </Framed>
  );
};
