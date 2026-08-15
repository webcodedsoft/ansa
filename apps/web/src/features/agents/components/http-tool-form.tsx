"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Card,
  CheckboxField,
  FieldError,
  Notice,
  SelectField,
  Stack,
  Stepper,
  Tag,
  TextAreaField,
  TextField,
  type StepDef,
  type Tone,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  sampleEndpointAction,
  saveHttpToolAction,
  testToolAction,
  type SampleState,
  type ToolsState,
} from "../agents.actions";
import {
  METHODS,
  PARAM_TYPES,
  RISK_TIERS,
  emptyDraft,
  fieldsIn,
  hostOf,
  isPlaintext,
  pathParamsIn,
  problemsWith,
  schemaFromParams,
  toApiTool,
  type HttpToolDraft,
  type Method,
  type ParamType,
  type RiskTier,
} from "../http-tool.schema";

/**
 * One HTTP tool, as five steps that are also five sections.
 *
 * `Stepper` keeps every step clickable, which is the whole reason it suits this. A strict
 * wizard is right the first time and wrong afterwards, when somebody arrives wanting to
 * change a timeout and should not have to walk past four screens to reach it. Stepped to
 * learn, jumpable to edit.
 *
 * The order is the order the work actually has to happen in, and step 3 is why: you cannot
 * write the sentence the agent speaks until you know what the endpoint returns. Before this
 * existed the only way to find out was to save, run the sandbox and come back — so the
 * sentence got written from memory, and a placeholder naming a field the response did not
 * have made the agent say "I couldn't find that policy" on every single call.
 *
 * The rules live in `http-tool.schema.ts` and mirror the connector's. This file decides only
 * where a message appears, never whether something is allowed.
 */

const TIER_TONE: Record<RiskTier, Tone> = { read: "ok", write: "warn", irreversible: "bad" };

const TIER_NOTE: Record<RiskTier, string> = {
  read: "Runs as soon as the agent asks for it. Lookups, status checks, balances.",
  write:
    "The agent reads the values back and waits for the caller to agree before it fires. Bookings, address changes.",
  irreversible:
    "Never runs on a call. The agent transfers to a person instead. Payments, cancellations.",
};

const SECTION = "text-[12px] font-semibold uppercase tracking-[0.09em] text-[var(--ink-3)]";
const CELL =
  "rounded-md border border-[var(--surface-line)] bg-[var(--surface)] px-2.5 py-1.5 text-[12.5px]";

interface Found {
  readonly path: string;
  readonly sample: string;
}

interface Props {
  readonly initial?: HttpToolDraft;
  readonly configVersion: number;
  /** Every other tool's name, so a clash is caught before the API refuses it. */
  readonly takenNames: readonly string[];
  readonly allowPlaintextHttp: boolean;
  readonly credentials: readonly string[];
  readonly onDone?: () => void;
}

export const HttpToolForm = ({
  initial,
  configVersion,
  takenNames,
  allowPlaintextHttp,
  credentials,
  onDone,
}: Props) => {
  const [draft, setDraft] = useState<HttpToolDraft>(initial ?? emptyDraft());
  const [showProblems, setShowProblems] = useState(false);
  const [fields, setFields] = useState<readonly Found[]>([]);
  const [state, action, pending] = useActionState(saveHttpToolAction, idleForm() as ToolsState);
  const formRef = useRef<HTMLFormElement>(null);

  useFormToast(state, (data) => {
    onDone?.();
    return `Published configuration version ${data.configVersion}.`;
  });

  const edit = (over: Partial<HttpToolDraft>) => {
    setDraft((current) => ({ ...current, ...over }));
  };

  const problems = useMemo(
    () => problemsWith(draft, { takenNames, allowPlaintextHttp, credentials }),
    [draft, takenNames, allowPlaintextHttp, credentials],
  );
  const problem = (key: string) => (showProblems ? problems[key] : undefined);

  const host = hostOf(draft.url);
  const pathParams = pathParamsIn(draft.url);
  const declared = new Set(draft.params.map((param) => param.name));

  /* A GET cannot carry a body, so the choice is removed rather than left to be refused on
     save. The stored value is corrected with it — otherwise a POST switched to GET keeps
     `body` in state, the control is hidden, and nobody can see or fix what is wrong. */
  const sendMode = draft.method === "GET" ? "query" : draft.send;
  const setMethod = (method: Method) =>
    edit({ method, send: method === "GET" ? "query" : draft.send });

  const setParam = (index: number, over: Partial<HttpToolDraft["params"][number]>) =>
    edit({
      params: draft.params.map((param, at) => (at === index ? { ...param, ...over } : param)),
    });

  const setHeader = (index: number, over: Partial<HttpToolDraft["headers"][number]>) =>
    edit({
      headers: draft.headers.map((header, at) => (at === index ? { ...header, ...over } : header)),
    });

  const count = Object.keys(problems).length;

  const save = () => {
    setShowProblems(true);
    formRef.current?.requestSubmit();
  };

  const steps: readonly StepDef[] = [
    {
      id: "endpoint",
      title: "Endpoint",
      hint: "What it is and where it goes",
      panel: (
        <Stack>
          <Card title="What it is" description="How the agent decides to reach for this, mid-call.">
            <Stack>
              <TextField
                label="Name"
                value={draft.name}
                onChange={(event) => edit({ name: event.target.value })}
                error={problem("name")}
                hint="Lowercase, underscores. The model refers to it by this."
                placeholder="lookup_policy"
              />
              <TextAreaField
                label="When should the agent use it?"
                value={draft.description}
                onChange={(event) => edit({ description: event.target.value })}
                error={problem("description")}
                rows={2}
                hint="Written for the model, not for a person. A vague sentence gets the wrong tool called."
                placeholder="Look up a motor policy by its policy number."
              />
            </Stack>
          </Card>

          <Card title="Where it goes" description="The endpoint, and how the arguments get there.">
            <Stack>
              <div className="grid gap-3.5 sm:grid-cols-[110px_minmax(0,1fr)]">
                <SelectField
                  label="Method"
                  value={draft.method}
                  onChange={(event) => setMethod(event.target.value as Method)}
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
                  placeholder="https://api.acme.ng/policies/{policyNumber}"
                  hint="Put {curly braces} around any part of the path that is an argument."
                />
              </div>

              {host !== null && problem("url") === undefined && (
                <Notice tone="warn">
                  <span className="font-mono text-[12.5px]">{host}</span> will be added to the
                  egress allowlist when you save. Without it the tool registers and every call
                  answers &ldquo;sorry, I couldn&rsquo;t get that just now&rdquo;.
                  {isPlaintext(draft.url) && allowPlaintextHttp && (
                    <>
                      {" "}
                      This is plain http, so the request and its credential cross the network
                      unencrypted.
                    </>
                  )}
                </Notice>
              )}

              <SelectField
                label="Send the remaining arguments as"
                value={sendMode}
                onChange={(event) => edit({ send: event.target.value as "query" | "body" })}
                error={problem("send")}
                disabled={draft.method === "GET"}
                hint={
                  draft.method === "GET"
                    ? "A GET cannot carry a body, so these go in the query string."
                    : "Anything already used by a {placeholder} in the path is not sent again."
                }
              >
                <option value="query">Query string &mdash; ?policyNumber=PM8592625</option>
                {draft.method !== "GET" && <option value="body">JSON body</option>}
              </SelectField>

              {pathParams.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--ink-3)]">
                  <span>The path takes</span>
                  {pathParams.map((name) => (
                    <Tag key={name} tone={declared.has(name) ? "ok" : "bad"}>
                      <span className="font-mono text-[11px]">{name}</span>
                    </Tag>
                  ))}
                  <span>&mdash; each needs a parameter in the next step with the same name.</span>
                </p>
              )}

              {credentials.length === 0 ? (
                <div>
                  <span className={SECTION}>Credential</span>
                  <p className="mt-1 max-w-[70ch] text-[12.5px] text-[var(--ink-3)]">
                    This organisation has none stored, so there is nothing to pick and the
                    endpoint will be called unauthenticated. Credentials are held separately
                    and never shown again once saved &mdash; not even masked.
                  </p>
                  <Link
                    href="/credentials"
                    className="mt-2 inline-block text-sm font-medium text-[var(--accent)] hover:underline"
                  >
                    Store a credential &rarr;
                  </Link>
                </div>
              ) : (
                <SelectField
                  label="Credential"
                  value={draft.credentialRef}
                  onChange={(event) => edit({ credentialRef: event.target.value })}
                  error={problem("credentialRef")}
                  hint="Stored separately and never shown. Leave as None for an open endpoint."
                >
                  <option value="">None</option>
                  {credentials.map((ref) => (
                    <option key={ref} value={ref}>
                      {ref}
                    </option>
                  ))}
                </SelectField>
              )}

              <div>
                <span className={SECTION}>Headers</span>
                <p className="mt-1 max-w-[70ch] text-[12.5px] text-[var(--ink-3)]">
                  Fixed values sent with every request. Not authentication &mdash; that is the
                  credential above, so the secret is never stored in this document.
                </p>
                <div className="mt-2.5 flex flex-col gap-2">
                  {draft.headers.map((header, index) => (
                    <div key={index}>
                      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
                        <input
                          className={`${CELL} font-mono`}
                          value={header.name}
                          onChange={(event) => setHeader(index, { name: event.target.value })}
                          placeholder="X-Tenant"
                          aria-label={`Header ${index + 1} name`}
                        />
                        <input
                          className={`${CELL} font-mono`}
                          value={header.value}
                          onChange={(event) => setHeader(index, { value: event.target.value })}
                          placeholder="acme"
                          aria-label={`Header ${index + 1} value`}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            edit({ headers: draft.headers.filter((_, at) => at !== index) })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                      {problem(`headers.${index}`) !== undefined && (
                        <FieldError>{problem(`headers.${index}`)}</FieldError>
                      )}
                    </div>
                  ))}
                  <div>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => edit({ headers: [...draft.headers, { name: "", value: "" }] })}
                    >
                      Add header
                    </Button>
                  </div>
                </div>
              </div>
            </Stack>
          </Card>
        </Stack>
      ),
    },

    {
      id: "parameters",
      title: "Parameters",
      hint: "What the agent may send",
      panel: (
        <Card
          title="What the agent may send"
          description="The arguments the model fills in from the conversation."
        >
          <Stack>
            {draft.useRawParameters ? (
              <>
                <Notice tone="warn">
                  This tool&rsquo;s schema is more than the builder can show &mdash; nested
                  fields, a fixed set of values, or something else written by hand. It is kept
                  exactly as it is, so saving cannot quietly simplify it.
                </Notice>
                <TextAreaField
                  label="Parameters (JSON Schema)"
                  value={draft.parametersJson}
                  onChange={(event) => edit({ parametersJson: event.target.value })}
                  error={problem("parametersJson")}
                  rows={10}
                  className="font-mono text-[12.5px]"
                />
              </>
            ) : (
              <>
                <div className="flex flex-col gap-2">
                  {draft.params.map((param, index) => (
                    <div key={index}>
                      <div className="grid grid-cols-[minmax(0,1fr)_100px_minmax(0,1.4fr)_auto_auto] items-center gap-2">
                        <input
                          className={`${CELL} font-mono`}
                          value={param.name}
                          onChange={(event) => setParam(index, { name: event.target.value })}
                          placeholder="policyNumber"
                          aria-label={`Parameter ${index + 1} name`}
                        />
                        <select
                          className={CELL}
                          value={param.type}
                          onChange={(event) =>
                            setParam(index, { type: event.target.value as ParamType })
                          }
                          aria-label={`Parameter ${index + 1} type`}
                        >
                          {PARAM_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {type}
                            </option>
                          ))}
                        </select>
                        <input
                          className={CELL}
                          value={param.description}
                          onChange={(event) => setParam(index, { description: event.target.value })}
                          placeholder="What it is, for the model"
                          aria-label={`Parameter ${index + 1} description`}
                        />
                        <CheckboxField
                          label="Required"
                          checked={param.required}
                          onChange={(event) => setParam(index, { required: event.target.checked })}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          onClick={() =>
                            edit({ params: draft.params.filter((_, at) => at !== index) })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                      {problem(`params.${index}`) !== undefined && (
                        <FieldError>{problem(`params.${index}`)}</FieldError>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      edit({
                        params: [
                          ...draft.params,
                          { name: "", type: "string", description: "", required: true },
                        ],
                      })
                    }
                  >
                    Add parameter
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      edit({
                        useRawParameters: true,
                        parametersJson: schemaFromParams(draft.params),
                      })
                    }
                  >
                    Edit as JSON Schema
                  </Button>
                </div>
              </>
            )}
          </Stack>
        </Card>
      ),
    },

    {
      id: "response",
      title: "Response",
      hint: "See what it returns",
      panel: <SampleStep draft={draft} onFields={setFields} found={fields} />,
    },

    {
      id: "behaviour",
      title: "What it says",
      hint: "Risk tier and the sentences",
      panel: (
        <Card
          title="What it is allowed to do"
          description="Enforced in the dispatch path, never by a prompt."
        >
          <Stack>
            <div className="flex flex-wrap items-center gap-2">
              {RISK_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => edit({ riskTier: tier })}
                  aria-pressed={draft.riskTier === tier}
                  className={`rounded-lg border px-3 py-1.5 text-[13px] font-medium transition ${
                    draft.riskTier === tier
                      ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                      : "border-[var(--surface-line)] text-[var(--ink-2)] hover:border-[var(--ink-3)]"
                  }`}
                >
                  {tier}
                </button>
              ))}
              <Tag tone={TIER_TONE[draft.riskTier]}>{draft.riskTier}</Tag>
            </div>
            <p className="max-w-[70ch] text-[13px] text-[var(--ink-2)]">
              {TIER_NOTE[draft.riskTier]}
            </p>

            {draft.riskTier === "irreversible" ? (
              <TextField
                label="Why the caller is being transferred"
                value={draft.transferReason}
                onChange={(event) => edit({ transferReason: event.target.value })}
                error={problem("transferReason")}
                hint="Spoken to the caller. This tool never runs, whatever else is configured."
                placeholder="Cancellations are handled by a colleague."
              />
            ) : (
              <>
                <TextField
                  label="What the agent says with the answer"
                  value={draft.speechTemplate}
                  onChange={(event) => edit({ speechTemplate: event.target.value })}
                  error={problem("speechTemplate")}
                  placeholder="Your policy renews on {renewsOn}."
                  hint="Use {placeholders} for fields from the response."
                />

                {fields.length > 0 && (
                  <div>
                    <span className={SECTION}>From the response you fetched</span>
                    <p className="mt-1 text-[12px] text-[var(--ink-3)]">
                      Click to add. These are the paths that will resolve &mdash; anything else
                      falls through to the no-record sentence.
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {fields.map((field) => (
                        <button
                          key={field.path}
                          type="button"
                          onClick={() =>
                            edit({ speechTemplate: `${draft.speechTemplate}{${field.path}}` })
                          }
                          className="rounded-md border border-[var(--surface-line)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink-2)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
                          title={field.sample}
                        >
                          {field.path}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <TextField
                  label="What the agent says when there is no record"
                  value={draft.speechFallback}
                  onChange={(event) => edit({ speechFallback: event.target.value })}
                  error={problem("speechFallback")}
                  placeholder="I couldn't find a policy with that number."
                  hint="Also used when the endpoint answers 404 — which means the lookup worked and found nothing."
                />
                {draft.riskTier === "write" && (
                  <TextField
                    label="Read back before it fires"
                    value={draft.readback}
                    onChange={(event) => edit({ readback: event.target.value })}
                    error={problem("readback")}
                    placeholder="I'll change your address to {address}. Shall I go ahead?"
                    hint="Quote the caller's own values back. The tool does not run until they say yes."
                  />
                )}
              </>
            )}

            <TextField
              label="Timeout (ms)"
              value={draft.timeoutMs}
              onChange={(event) => edit({ timeoutMs: event.target.value })}
              error={problem("timeoutMs")}
              hint="Blank uses the platform default. A caller hears silence for however long this is."
              placeholder="3000"
            />
          </Stack>
        </Card>
      ),
    },

    {
      id: "test",
      title: "Test",
      hint: "Through the real dispatch path",
      panel: <ToolTest name={initial?.name ?? ""} draft={draft} />,
    },
  ];

  return (
    <Stack>
      {(state.status === "failed" || state.status === "invalid") && (
        <Notice tone="error">{state.message}</Notice>
      )}
      {showProblems && count > 0 && (
        <Notice tone="error">
          {count} thing{count === 1 ? "" : "s"} to fix before this can be saved.
        </Notice>
      )}

      {/* Only the hidden fields live in the form. Every visible control is React state, so
          the tool is serialised once, here, rather than reassembled from FormData — which
          also keeps the Stepper's own Back and Continue buttons out of a form they would
          otherwise submit. */}
      <form
        ref={formRef}
        action={(form) => {
          form.set("tool", JSON.stringify(toApiTool(draft)));
          action(form);
        }}
      >
        <input type="hidden" name="expectedVersion" value={configVersion} />
        <input type="hidden" name="replacing" value={initial?.name ?? ""} />
      </form>

      <Stepper
        steps={steps}
        finishLabel={pending ? "Saving…" : initial === undefined ? "Add tool" : "Save changes"}
        onFinish={save}
      />

      {/* Saving from any step, not only the last. Somebody who came back to change a timeout
          should not have to walk to the end to keep it. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? "Saving…" : initial === undefined ? "Add tool" : "Save changes"}
        </Button>
        <span className="text-[12.5px] text-[var(--ink-3)]">
          Saves from wherever you are in the steps.
        </span>
      </div>
    </Stack>
  );
};

/**
 * Fetch one real response, and turn it into the list of paths a template may name.
 *
 * A GET only, and the API refuses anything else. A "sample" of a POST would perform whatever
 * that POST does, and finding out what a cancellation endpoint returns by cancelling
 * something is not a preview. For those the tier is the answer: save, then use the test
 * step, where a write answers `confirm` without firing.
 */
const SampleStep = ({
  draft,
  onFields,
  found,
}: {
  readonly draft: HttpToolDraft;
  readonly onFields: (fields: readonly Found[]) => void;
  readonly found: readonly Found[];
}) => {
  const [state, action, pending] = useActionState(sampleEndpointAction, idleForm() as SampleState);

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
    <Card
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
              <Button type="submit" disabled={pending || draft.url === ""}>
                {pending ? "Fetching…" : "Fetch a sample"}
              </Button>
            </div>
          </Stack>
        </form>

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

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
                  className="rounded-md border border-[var(--surface-line)] px-2 py-1 font-mono text-[11.5px] text-[var(--ink-2)]"
                >
                  {field.path}
                  <span className="ml-1.5 text-[var(--ink-3)]">{field.sample}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Stack>
    </Card>
  );
};

/**
 * Run the saved tool through the real dispatch path.
 *
 * Only for a tool that exists: the sandbox runs what is stored, not what is on screen.
 * Saying so matters — a tester that silently ran the previous version would be worse than
 * none, because it would build confidence in the wrong thing.
 */
const ToolTest = ({ name, draft }: { readonly name: string; readonly draft: HttpToolDraft }) => {
  const [state, action, pending] = useActionState(testToolAction, idleForm());

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

  if (name === "") {
    return (
      <Card title="Test it" description="Available once the tool is saved.">
        <p className="max-w-[70ch] text-[13px] text-[var(--ink-2)]">
          The sandbox runs what is stored, not what is on screen. Save first, then come back
          &mdash; unlike the sample fetch, this goes through the whole dispatch path, so the
          risk tier, the timeout and the spoken sentence are the ones a caller would get.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Test it"
      description="Runs through the same dispatch path a call uses, with the same risk tier."
    >
      <form action={action}>
        <input type="hidden" name="name" value={name} />
        <Stack>
          <TextAreaField
            label="Arguments"
            name="argsJson"
            defaultValue={suggested}
            rows={5}
            className="font-mono text-[12.5px]"
            hint="Stands in for what the model would pass."
          />
          <Notice tone="warn">
            A <span className="font-mono">write</span> tool answers &ldquo;confirm&rdquo; and does
            not fire; an <span className="font-mono">irreversible</span> one answers
            &ldquo;transfer&rdquo; and never runs. That is the tier working, not a failure.
          </Notice>
          <div>
            <Button type="submit" disabled={pending}>
              {pending ? "Running…" : "Run test"}
            </Button>
          </div>
          {(state.status === "failed" || state.status === "invalid") && (
            <Notice tone="error">{state.message}</Notice>
          )}
        </Stack>
      </form>
    </Card>
  );
};
