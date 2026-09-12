"use client";

import { useActionState, useMemo, useRef, useState } from "react";

import {
  Button,
  CheckboxField,
  ChoiceChips,
  FieldError,
  millisLabel,
  Notice,
  SelectField,
  Stack,
  Tag,
  TextAreaField,
  TextField,
  type Tone,
} from "@/components/ui";
import { CredentialModal } from "@/features/connect/components/credential-modal";
import { cn } from "@/lib/cn";
import { idleForm } from "@/lib/form-state";
import { useFailureToast, useFormToast } from "@/stores/toast.store";

import { saveHttpToolAction, type ToolsState } from "../agents.actions";
import { parseCurl } from "../curl-import";
import {
  METHODS,
  PARAM_TYPES,
  RISK_TIERS,
  TIMEOUT_PRESETS_MS,
  emptyDraft,
  problemsWith,
  toApiTool,
  urlParamsIn,
  type HttpToolDraft,
  type Method,
  type ParamType,
  type RiskTier,
} from "../http-tool.schema";
import { HOST, type ToolTemplate } from "../tool-templates";
import { SpeechTemplateField, type ResponseField } from "./speech-template-field";
import { SampleStep, ToolTest } from "./tool-steps";
import { ToolTemplateGallery } from "./tool-template-gallery";

/**
 * The tool builder, sized for a dialog.
 *
 * The registry's builder is five sections that are also five steps, all on one page, with a
 * sample fetch and a live test in the middle. Put whole into a dialog over the agent's Tools
 * tab it ran to three screens of scrolling before the first field, and the dialog looked
 * like the page it was meant to save somebody from visiting.
 *
 * This is the same tool — the same draft, the same rules in `http-tool.schema.ts`, the same
 * save action, the same sample fetch and the same test — as five short screens, one at a
 * time, each of which fits without scrolling. Headers and the raw JSON schema are behind a
 * fold, because most tools have neither.
 *
 * Each screen is checked when Continue is pressed, against only its own fields, so a problem
 * is raised on the screen that can fix it rather than three screens later.
 */

const STEPS = [
  { id: "endpoint", title: "Endpoint" },
  { id: "arguments", title: "Arguments" },
  { id: "response", title: "Response" },
  { id: "call", title: "On the call" },
  { id: "test", title: "Test" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

const stepOf = (key: string): StepId => {
  if (key.startsWith("params") || key === "parametersJson") return "arguments";
  if (["speechTemplate", "speechFallback", "readback", "transferReason", "timeoutMs"].includes(key)) return "call";
  return "endpoint";
};

const TIER_TONE: Record<RiskTier, Tone> = { read: "ok", write: "warn", irreversible: "bad" };
const TIER_NOTE: Record<RiskTier, string> = {
  read: "Runs as soon as the agent asks. Lookups, balances, status checks.",
  write: "Reads the values back and waits for the caller to agree before it fires.",
  irreversible: "Never runs on a call. The agent transfers to a person instead.",
};

const SECTION = "text-[11.5px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]";
const CELL =
  "h-8 w-full rounded-md border border-[var(--surface-line)] bg-[var(--surface)] px-2.5 text-[12.5px] outline-none focus:border-[var(--accent)]";

interface Props {
  readonly configVersion: number;
  readonly takenNames: readonly string[];
  readonly allowPlaintextHttp: boolean;
  readonly credentials: readonly string[];
  readonly onDone: (saved: { readonly name: string }) => void;
  readonly onCancel: () => void;
}

export const QuickToolForm = ({ configVersion, takenNames, allowPlaintextHttp, credentials, onDone, onCancel }: Props) => {
  const [draft, setDraft] = useState<HttpToolDraft>(emptyDraft);
  const [step, setStep] = useState<StepId>("endpoint");
  /* Which screens have had Continue pressed. A problem is shown only on a screen the person
     has tried to leave — a blank form should not open covered in red. */
  const [checked, setChecked] = useState<ReadonlySet<StepId>>(new Set());
  const [known, setKnown] = useState<readonly string[]>(credentials);
  const [storing, setStoring] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [startedFrom, setStartedFrom] = useState<ToolTemplate | null>(null);
  const [pasting, setPasting] = useState(false);
  const [curl, setCurl] = useState("");
  const [imported, setImported] = useState<readonly string[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  /** What the sample fetch found in the response, offered when writing the spoken sentence. */
  const [fields, setFields] = useState<readonly ResponseField[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(saveHttpToolAction, idleForm() as ToolsState);
  useFailureToast(state);
  useFormToast(state, () => {
    onDone({ name: draft.name });
    return `${draft.name} is in the registry and switched on for this agent.`;
  });

  const edit = (over: Partial<HttpToolDraft>): void => setDraft((current) => ({ ...current, ...over }));

  const problems = useMemo(
    () => problemsWith(draft, { takenNames, allowPlaintextHttp, credentials: known }),
    [draft, takenNames, allowPlaintextHttp, known],
  );
  const problem = (key: string): string | undefined =>
    checked.has(stepOf(key)) ? problems[key] : undefined;
  const problemsOn = (id: StepId): number => Object.keys(problems).filter((key) => stepOf(key) === id).length;

  const at = STEPS.findIndex((entry) => entry.id === step);
  const last = at === STEPS.length - 1;

  /* Placeholders in the URL with no argument yet. One click each; the quiet failure this
     prevents is a tool that saves and then fails on every call for want of the argument. */
  const undeclaredIn = (candidate: HttpToolDraft): readonly string[] =>
    urlParamsIn(candidate.url).filter((name) => !candidate.params.some((param) => param.name === name));
  const declaring = (candidate: HttpToolDraft): HttpToolDraft => ({
    ...candidate,
    params: [
      ...candidate.params,
      ...undeclaredIn(candidate).map((name) => ({ name, type: "string" as const, description: "", required: true })),
    ],
  });

  const continueFrom = (): void => {
    setChecked((current) => new Set([...current, step]));
    /* Leaving the endpoint screen declares the URL's {placeholders} as arguments. The rule
       that a placeholder needs an argument is reported against the URL, but the argument
       can only be added on the next screen — so it is added on the way there, rather than
       holding somebody on a screen that cannot fix what it is complaining about. */
    const next = step === "endpoint" && !draft.useRawParameters ? declaring(draft) : draft;
    if (next !== draft) setDraft(next);
    const remaining = problemsWith(next, { takenNames, allowPlaintextHttp, credentials: known });
    if (Object.keys(remaining).some((key) => stepOf(key) === step)) return;
    const following = STEPS[at + 1];
    if (following !== undefined) setStep(following.id);
  };

  /** Mark every screen and go to the first one with a problem. True when there was one. */
  const showAllProblems = (): boolean => {
    setChecked(new Set(STEPS.map((entry) => entry.id)));
    const firstBroken = STEPS.find((entry) => problemsOn(entry.id) > 0);
    if (firstBroken === undefined) return false;
    setStep(firstBroken.id);
    return true;
  };

  const save = (): void => {
    if (showAllProblems()) return;
    formRef.current?.requestSubmit();
  };

  const STEP_TITLE: Record<StepId, string> = Object.fromEntries(STEPS.map((entry) => [entry.id, entry.title])) as Record<StepId, string>;
  const blockers = Object.entries(problems).map(([key, message]) => ({ step: STEP_TITLE[stepOf(key)], message }));

  const applyCurl = (): void => {
    const parsed = parseCurl(curl);
    setImported(parsed.unsupported);
    if (parsed.draft.url === "") return;
    edit({ url: parsed.draft.url, method: parsed.draft.method, send: parsed.draft.send, headers: parsed.draft.headers });
    if (parsed.draft.headers.length > 0) setShowHeaders(true);
  };

  const stored = (ref: string): void => {
    setKnown((current) => (current.includes(ref) ? current : [...current, ref]));
    edit({ credentialRef: ref });
    setStoring(false);
  };

  const setParam = (index: number, over: Partial<HttpToolDraft["params"][number]>): void =>
    edit({ params: draft.params.map((param, index2) => (index2 === index ? { ...param, ...over } : param)) });

  const undeclared = undeclaredIn(draft);

  const sendMode = draft.method === "GET" ? "query" : draft.send;

  return (
    <div className="flex flex-col gap-4">
      {/* The steps, as a row of three. Backwards through Back only — jumping ahead past an
          unchecked screen is how a half-filled tool gets saved. */}
      <ol className="flex items-center gap-1.5 text-[12px]">
        {STEPS.map((entry, index) => {
          const done = index < at;
          const broken = checked.has(entry.id) && problemsOn(entry.id) > 0;
          return (
            <li key={entry.id} className="flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium",
                  index === at
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : broken
                      ? "border-[var(--bad)] text-[var(--bad)]"
                      : done
                        ? "border-[var(--hairline)] text-[var(--ink-2)]"
                        : "border-[var(--hairline)] text-[var(--ink-3)]",
                )}
              >
                <span className="font-mono text-[11px]">{index + 1}</span>
                {entry.title}
              </span>
              {index < STEPS.length - 1 && <span aria-hidden className="h-px w-4 bg-[var(--hairline)]" />}
            </li>
          );
        })}
      </ol>

      {/* Only the hidden fields live in the form; see the registry's builder for why. */}
      <form
        ref={formRef}
        action={(form) => {
          form.set("tool", JSON.stringify(toApiTool(draft)));
          action(form);
        }}
      >
        <input type="hidden" name="expectedVersion" value={configVersion} />
        <input type="hidden" name="replacing" value="" />
      </form>

      {step === "endpoint" && (
        <Stack gap="sm">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setBrowsing(true)}>
              Start from a template
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setPasting((current) => !current)} aria-expanded={pasting}>
              {pasting ? "Hide the curl box" : "Paste a curl command"}
            </Button>
            {startedFrom !== null && (
              <span className="text-[12px] text-[var(--ink-3)]">
                From <strong className="text-[var(--ink-2)]">{startedFrom.draft.name}</strong>
                {draft.url.startsWith(HOST) ? " — replace the host below." : "."}
              </span>
            )}
          </div>
          <ToolTemplateGallery
            open={browsing}
            onClose={() => setBrowsing(false)}
            taken={takenNames}
            onPick={(template) => {
              setDraft(template.draft);
              setStartedFrom(template);
              setImported([]);
              setChecked(new Set());
              setBrowsing(false);
            }}
          />
          {pasting && (
            <div className="rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] p-3">
              <TextAreaField
                label="curl command"
                hideLabel
                rows={3}
                mono
                value={curl}
                onChange={(event: { target: { value: string } }) => setCurl(event.target.value)}
                placeholder="curl -X POST https://api.example.com/customers -H 'Accept: application/json'"
              />
              {imported.length > 0 && (
                <p className="mt-2 text-[12px] text-[var(--warn)]">It did not take {imported.join("; ")}.</p>
              )}
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={applyCurl} disabled={curl.trim() === ""}>
                  Fill in from this
                </Button>
              </div>
            </div>
          )}

          <TextField
            label="Name"
            value={draft.name}
            onChange={(event) => edit({ name: event.target.value })}
            error={problem("name")}
            placeholder="look_up_customer"
            hint="Lowercase, underscores. The model refers to it by this."
            mono
          />
          <TextAreaField
            label="When should the agent use it?"
            value={draft.description}
            onChange={(event) => edit({ description: event.target.value })}
            error={problem("description")}
            rows={2}
            placeholder="Look up a customer by their reference number."
          />

          <div className="grid gap-3 sm:grid-cols-[110px_minmax(0,1fr)]">
            <SelectField
              label="Method"
              value={draft.method}
              onChange={(event) => {
                const method = event.target.value as Method;
                edit({ method, send: method === "GET" ? "query" : draft.send });
              }}
            >
              {METHODS.map((method) => (
                <option key={method} value={method}>
                  {method}
                </option>
              ))}
            </SelectField>
            <TextField
              label="URL"
              value={draft.url}
              onChange={(event) => edit({ url: event.target.value })}
              error={problem("url")}
              placeholder="https://api.example.ng/customers/{reference}"
              hint="{curly braces} around any part that is an argument."
              mono
            />
          </div>

          {draft.method !== "GET" && (
            <SelectField
              label="Send the arguments as"
              value={sendMode}
              onChange={(event) => edit({ send: event.target.value as "query" | "body" })}
              error={problem("send")}
            >
              <option value="body">A JSON body</option>
              <option value="query">The query string</option>
            </SelectField>
          )}

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <SelectField
              label="Credential"
              value={draft.credentialRef}
              onChange={(event) => edit({ credentialRef: event.target.value })}
              error={problem("credentialRef")}
              hint={known.length === 0 ? "None stored yet. Leave as None for an open endpoint." : "Stored separately and never shown."}
            >
              <option value="">None</option>
              {known.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </SelectField>
            <div className="sm:pb-[26px]">
              <Button variant="secondary" onClick={() => setStoring(true)}>
                Store a new one
              </Button>
            </div>
          </div>
          <CredentialModal open={storing} onClose={() => setStoring(false)} onStored={stored} />

          <div>
            <button
              type="button"
              onClick={() => setShowHeaders((current) => !current)}
              aria-expanded={showHeaders}
              className="text-[12.5px] font-medium text-[var(--ink-3)] hover:text-[var(--ink)]"
            >
              {showHeaders ? "Hide fixed headers" : `Fixed headers${draft.headers.length > 0 ? ` (${draft.headers.length})` : ""}`}
            </button>
            {showHeaders && (
              <div className="mt-2 flex flex-col gap-2">
                {draft.headers.map((header, index) => (
                  <div key={index}>
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
                      <input
                        className={cn(CELL, "font-mono")}
                        value={header.name}
                        onChange={(event) =>
                          edit({ headers: draft.headers.map((entry, index2) => (index2 === index ? { ...entry, name: event.target.value } : entry)) })
                        }
                        placeholder="Accept"
                        aria-label={`Header ${index + 1} name`}
                      />
                      <input
                        className={cn(CELL, "font-mono")}
                        value={header.value}
                        onChange={(event) =>
                          edit({ headers: draft.headers.map((entry, index2) => (index2 === index ? { ...entry, value: event.target.value } : entry)) })
                        }
                        placeholder="application/json"
                        aria-label={`Header ${index + 1} value`}
                      />
                      <Button size="sm" variant="secondary" onClick={() => edit({ headers: draft.headers.filter((_, index2) => index2 !== index) })}>
                        Remove
                      </Button>
                    </div>
                    {problem(`headers.${index}`) !== undefined && <FieldError>{problem(`headers.${index}`)}</FieldError>}
                  </div>
                ))}
                <div>
                  <Button size="sm" variant="secondary" onClick={() => edit({ headers: [...draft.headers, { name: "", value: "" }] })}>
                    Add header
                  </Button>
                </div>
                <p className="text-[12px] text-[var(--ink-3)]">
                  Not authentication — that is the credential above, so the secret is never stored here.
                </p>
              </div>
            )}
          </div>
        </Stack>
      )}

      {step === "arguments" && (
        <Stack gap="sm">
          <p className="text-[13px] text-[var(--ink-2)]">
            What the model fills in from the conversation. Each one is sent{" "}
            {sendMode === "body" ? "in the body" : "in the query string"}, unless the URL names it.
          </p>

          {draft.useRawParameters ? (
            <>
              <Notice tone="warn">
                This tool&rsquo;s schema is more than these rows can show. It is kept exactly as written.
              </Notice>
              <TextAreaField
                label="Parameters (JSON Schema)"
                value={draft.parametersJson}
                onChange={(event) => edit({ parametersJson: event.target.value })}
                error={problem("parametersJson")}
                rows={8}
                mono
              />
            </>
          ) : (
            <>
              {undeclared.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--ink-2)]">
                  The URL uses
                  {undeclared.map((name) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => edit({ params: [...draft.params, { name, type: "string", description: "", required: true }] })}
                      className="rounded-[4px] border border-[var(--bad)] px-2 py-0.5 font-mono text-[11.5px] text-[var(--bad)] transition hover:bg-[var(--bad)] hover:text-white"
                    >
                      + {name}
                    </button>
                  ))}
                  &mdash; click to add {undeclared.length === 1 ? "it" : "them"}.
                </div>
              )}
              {draft.params.length === 0 && undeclared.length === 0 && (
                <p className="text-[12.5px] text-[var(--ink-3)]">None yet. A lookup usually has one: the thing being looked up.</p>
              )}
              <div className="flex flex-col gap-2">
                {draft.params.map((param, index) => (
                  <div key={index}>
                    <div className="grid grid-cols-[minmax(0,1fr)_96px_minmax(0,1.4fr)_auto_auto] items-center gap-2">
                      <input
                        className={cn(CELL, "font-mono")}
                        value={param.name}
                        onChange={(event) => setParam(index, { name: event.target.value })}
                        placeholder="reference"
                        aria-label={`Argument ${index + 1} name`}
                      />
                      <SelectField
                        label={`Argument ${index + 1} type`}
                        hideLabel
                        size="sm"
                        value={param.type}
                        onChange={(event) => setParam(index, { type: event.target.value as ParamType })}
                      >
                        {PARAM_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </SelectField>
                      <input
                        className={CELL}
                        value={param.description}
                        onChange={(event) => setParam(index, { description: event.target.value })}
                        placeholder="What it is, for the model"
                        aria-label={`Argument ${index + 1} description`}
                      />
                      <CheckboxField label="Required" checked={param.required} onChange={(event) => setParam(index, { required: event.target.checked })} />
                      <Button size="sm" variant="secondary" onClick={() => edit({ params: draft.params.filter((_, index2) => index2 !== index) })}>
                        Remove
                      </Button>
                    </div>
                    {problem(`params.${index}`) !== undefined && <FieldError>{problem(`params.${index}`)}</FieldError>}
                  </div>
                ))}
              </div>
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => edit({ params: [...draft.params, { name: "", type: "string", description: "", required: true }] })}
                >
                  Add an argument
                </Button>
              </div>
            </>
          )}
        </Stack>
      )}

      {step === "response" && <SampleStep draft={draft} onFields={setFields} found={fields} frame="plain" />}

      {step === "test" && <ToolTest draft={draft} blockers={blockers} onBlocked={showAllProblems} frame="plain" />}

      {step === "call" && (
        <Stack gap="sm">
          <div>
            <span className={SECTION}>What it is allowed to do</span>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {RISK_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => edit({ riskTier: tier })}
                  aria-pressed={draft.riskTier === tier}
                  className={cn(
                    "rounded-[4px] border px-3 py-1.5 text-[13px] font-medium transition",
                    draft.riskTier === tier
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--surface-line)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
                  )}
                >
                  {tier}
                </button>
              ))}
              <Tag tone={TIER_TONE[draft.riskTier]}>{draft.riskTier}</Tag>
            </div>
            <p className="mt-1.5 text-[12.5px] text-[var(--ink-3)]">{TIER_NOTE[draft.riskTier]} Enforced in code, not by a prompt.</p>
          </div>

          {draft.riskTier === "irreversible" ? (
            <TextField
              label="Why the caller is being transferred"
              value={draft.transferReason}
              onChange={(event) => edit({ transferReason: event.target.value })}
              error={problem("transferReason")}
              placeholder="Cancellations are handled by a colleague."
              hint="Spoken to the caller. This tool never runs."
            />
          ) : (
            <>
              <SpeechTemplateField
                label="What the agent says with the answer"
                value={draft.speechTemplate}
                onChange={(next) => edit({ speechTemplate: next })}
                fields={fields}
                error={problem("speechTemplate")}
                placeholder="Your reference is {reference}, and the status is {status}."
                hint={fields.length > 0 ? undefined : "{placeholders} are fields from the response. Fetch a sample on the Response step to see which exist."}
              />
              <TextField
                label="What it says when there is no record"
                value={draft.speechFallback}
                onChange={(event) => edit({ speechFallback: event.target.value })}
                error={problem("speechFallback")}
                placeholder="I couldn't find anything under that reference."
              />
              {draft.riskTier === "write" && (
                <TextField
                  label="Read back before it fires"
                  value={draft.readback}
                  onChange={(event) => edit({ readback: event.target.value })}
                  error={problem("readback")}
                  placeholder="I'll change your address to {address}. Shall I go ahead?"
                  hint="Quote the caller's own values back. It does not run until they say yes."
                />
              )}
            </>
          )}

          <ChoiceChips
            label="Timeout"
            name="timeoutMs"
            presets={[...TIMEOUT_PRESETS_MS]}
            format={millisLabel}
            none="Default"
            value={draft.timeoutMs === "" ? null : Number(draft.timeoutMs)}
            onChange={(next) => edit({ timeoutMs: next === null ? "" : String(next) })}
            error={problem("timeoutMs")}
            hint="Three seconds is the most a phone line allows."
          />
        </Stack>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--hairline)] pt-3">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <div className="flex items-center gap-2">
          {at > 0 && (
            <Button variant="secondary" onClick={() => setStep(STEPS[at - 1]?.id ?? "endpoint")} disabled={pending}>
              Back
            </Button>
          )}
          {last ? (
            <Button onClick={save} pending={pending} disabled={pending}>
              Add tool
            </Button>
          ) : (
            <Button onClick={continueFrom}>Continue</Button>
          )}
        </div>
      </div>
    </div>
  );
};
