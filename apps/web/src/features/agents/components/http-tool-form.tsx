"use client";

import { useActionState, useMemo, useState } from "react";

import {
  Button,
  Card,
  CheckboxField,
  FieldError,
  Notice,
  SelectField,
  Stack,
  Tag,
  TextAreaField,
  TextField,
  type Tone,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { saveHttpToolAction, testToolAction, type ToolsState } from "../agents.actions";
import {
  METHODS,
  PARAM_TYPES,
  RISK_TIERS,
  emptyDraft,
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
 * One HTTP tool, on one page, in the order somebody thinks about it.
 *
 * Grouped like a wizard and laid out like a form: the sections are the questions a wizard
 * would ask one at a time, all visible at once. That combination is deliberate. Steps are
 * better the first time; a single sheet is better every time after, and most of a tool's
 * life is spent being edited rather than created. Making the groups obvious keeps the first
 * visit legible without making the tenth one a four-screen walk to change a timeout.
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
  const [state, action, pending] = useActionState(saveHttpToolAction, idleForm() as ToolsState);

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

  return (
    <Stack>
      {(state.status === "failed" || state.status === "invalid") && (
        <Notice tone="error">{state.message}</Notice>
      )}

      <form
        action={(form) => {
          form.set("tool", JSON.stringify(toApiTool(draft)));
          action(form);
        }}
      >
        <input type="hidden" name="expectedVersion" value={configVersion} />
        <input type="hidden" name="replacing" value={initial?.name ?? ""} />

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

          <Card
            title="Where it goes"
            description="The endpoint, and how the agent's arguments get there."
          >
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
                  <span>&mdash; each needs a parameter below with the same name.</span>
                </p>
              )}

              <SelectField
                label="Credential"
                value={draft.credentialRef}
                onChange={(event) => edit({ credentialRef: event.target.value })}
                error={problem("credentialRef")}
                hint="Stored separately and never shown. Leave blank for an open endpoint."
              >
                <option value="">None</option>
                {credentials.map((ref) => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </SelectField>

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
                            onChange={(event) =>
                              setParam(index, { description: event.target.value })
                            }
                            placeholder="What it is, for the model"
                            aria-label={`Parameter ${index + 1} description`}
                          />
                          <CheckboxField
                            label="Required"
                            checked={param.required}
                            onChange={(event) =>
                              setParam(index, { required: event.target.checked })
                            }
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
                    hint="Use {placeholders} for fields from the response. Test below to see what those are."
                  />
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

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending} onClick={() => setShowProblems(true)}>
              {pending ? "Saving…" : initial === undefined ? "Add tool" : "Save changes"}
            </Button>
            {showProblems && count > 0 && (
              <span className="text-[13px] text-[var(--bad)]">
                {count} thing{count === 1 ? "" : "s"} to fix above.
              </span>
            )}
          </div>
        </Stack>
      </form>

      <ToolTest name={initial?.name ?? ""} draft={draft} />
    </Stack>
  );
};

/**
 * Run the saved tool through the real dispatch path.
 *
 * Below the form rather than inside it, and only for a tool that exists: the sandbox runs
 * what is stored, not what is on screen. Saying so matters — a tester that silently ran the
 * previous version would be worse than none, because it would build confidence in the wrong
 * thing.
 *
 * This is where a speech template that quietly renders its fallback becomes visible, which
 * on a real call looks like the endpoint having no record of a customer who is standing
 * there on the phone.
 */
const ToolTest = ({
  name,
  draft,
}: {
  readonly name: string;
  readonly draft: HttpToolDraft;
}) => {
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
          The sandbox runs what is stored, not what is on screen. Save first, then run it
          &mdash; the response tells you which {"{placeholders}"} your sentence can actually
          use, which is otherwise a guess until somebody makes a phone call.
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
            A <span className="font-mono">write</span> tool answers &ldquo;confirm&rdquo; and
            does not fire; an <span className="font-mono">irreversible</span> one answers
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
