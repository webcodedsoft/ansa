import { emptyDraft, type HttpToolDraft, type ParamDraft, type ParamType } from "./http-tool.schema";

/**
 * Tool templates: what an organisation's front desk needs to *look up* and *do*, pre-written.
 *
 * The agent templates say what the agent asks; these say what it can check and act on —
 * a booking's status, a slot that is free, a fault logged, a repayment date recorded. A
 * template is a complete HTTP tool: the sentence the model picks it by, the parameters it
 * needs, the risk tier the dispatcher enforces, the sentence spoken from the response, the
 * fallback when there is no record, and for a write the readback of the caller's own values
 * before it fires. What it cannot know is the organisation's system, so the host is a
 * reserved `.example` name that can never resolve and `expects` says what shape the
 * endpoint should answer with. Replace the host, pick a credential, test, save.
 */
export interface ToolTemplate {
  readonly id: string;
  readonly name: string;
  /** Matches the agent catalogue's sectors, so a business finds its tools where it found its agent. */
  readonly sector: string;
  /** One line on the card: what this lets the agent do on a call. */
  readonly summary: string;
  /** The response shape the spoken sentence reads from, as a person would describe it. */
  readonly expects: string;
  readonly draft: HttpToolDraft;
}

/** Every organisation's system is at a different address; this one, by RFC 2606, is at none. */
export const HOST = "https://your-system.example";

const param = (name: string, type: ParamType, description: string, required = true): ParamDraft => ({ name, type, description, required });

export const str = (name: string, description: string, required = true): ParamDraft => param(name, "string", description, required);
export const num = (name: string, description: string, required = true): ParamDraft => param(name, "number", description, required);
export const bool = (name: string, description: string, required = true): ParamDraft => param(name, "boolean", description, required);

interface Common {
  readonly id: string;
  readonly sector: string;
  readonly summary: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly params: readonly ParamDraft[];
}

const base = (t: Common, over: Partial<HttpToolDraft>): HttpToolDraft => ({
  ...emptyDraft(),
  name: t.name,
  description: t.description,
  url: `${HOST}${t.path}`,
  params: t.params,
  ...over,
});

/**
 * A lookup. Executes freely; speaks what it found or the fallback.
 *
 * Four seconds, because a caller waiting on a lookup hears holding speech from the moment it
 * is dispatched and a system that takes longer than that is a system to fix, not to wait for.
 */
export const read = (t: Common & { readonly expects: string; readonly speech: string; readonly fallback: string }): ToolTemplate => ({
  id: t.id,
  name: t.name,
  sector: t.sector,
  summary: t.summary,
  expects: t.expects,
  draft: base(t, { method: "GET", send: "query", riskTier: "read", speechTemplate: t.speech, speechFallback: t.fallback, timeoutMs: "4000" }),
});

/**
 * A change. Read back to the caller and confirmed before it fires, then spoken from the
 * response. Six seconds, since a write usually does more on the other side.
 */
export const write = (
  t: Common & { readonly expects: string; readonly readback: string; readonly speech: string; readonly fallback: string; readonly method?: "POST" | "PUT" | "PATCH" },
): ToolTemplate => ({
  id: t.id,
  name: t.name,
  sector: t.sector,
  summary: t.summary,
  expects: t.expects,
  draft: base(t, {
    method: t.method ?? "POST",
    send: "body",
    riskTier: "write",
    readback: t.readback,
    speechTemplate: t.speech,
    speechFallback: t.fallback,
    timeoutMs: "6000",
  }),
});

/**
 * Something a machine must not do. Never executes: the dispatcher transfers to a person
 * and the caller hears why. Registered anyway, so the model knows the action exists and
 * hands over instead of improvising.
 */
export const irreversible = (t: Common & { readonly transferReason: string; readonly method?: "POST" | "DELETE" }): ToolTemplate => ({
  id: t.id,
  name: t.name,
  sector: t.sector,
  summary: t.summary,
  expects: "Nothing — this never reaches your system. The caller is put through to a person.",
  draft: base(t, { method: t.method ?? "POST", send: "body", riskTier: "irreversible", transferReason: t.transferReason }),
});
