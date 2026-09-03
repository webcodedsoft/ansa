import { validateFlow, type Flow, type Logger } from "@ansa/shared";

/**
 * The stored voice form, turned into something the prompt layer can state (migration 0021).
 *
 * A parser rather than a cast, and it never throws. `captured_fields` is jsonb: the API
 * validates it on the way in, and an operator with psql can write anything at all. A
 * malformed entry has to cost the agent that one field, never the call — the same promise
 * `prepareConnectors` makes about tools, and for the same reason. A configuration mistake
 * becoming silence on the line is the one outcome this product is not allowed to have.
 */

export type CaptureRoute = "speech" | "keypad" | "either";
export type Confirmation = "none" | "readback" | "spellback";

export interface CollectedField {
  readonly key: string;
  readonly type: string;
  /** The operator's own wording, said as speech. Empty when they have not written one. */
  readonly prompt: string;
  readonly capture: CaptureRoute;
  readonly confirm: Confirmation;
  readonly required: boolean;
  /**
   * The operator's own shape check, as a regular expression source. Empty means anything.
   *
   * Additional to the engine's, never instead of it: `ENTITY_POLICY` already counts an
   * eleven-digit NIN and rejects a malformed email, and those checks know how to say what
   * is wrong. This one knows the organisation's own format — a policy number that always
   * starts with two letters — which no generic parser could.
   */
  readonly pattern: string;
  /**
   * How many rejected values before the call goes to a person.
   *
   * Counted separately from the engine's own attempts, which are about not being *heard*.
   * This is about being heard perfectly and still not matching, and a caller who has read
   * the same wrong number out three times needs a human, not a fourth go.
   */
  readonly attempts: number;
}

const ROUTES: ReadonlySet<string> = new Set<CaptureRoute>(["speech", "keypad", "either"]);
const CONFIRMATIONS: ReadonlySet<string> = new Set<Confirmation>([
  "none",
  "readback",
  "spellback",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * Every kind the capture engine can hear, plus the two it cannot.
 *
 * Held as a set rather than a union so a document written by a newer console against an
 * older process degrades to `text` — heard and left in the transcript — instead of
 * throwing on the answer path.
 */
const KINDS: ReadonlySet<string> = new Set([
  "name", "reference", "phone", "email", "address", "date", "time",
  "amount", "nin", "bvn", "otp", "quantity", "choice", "text",
]);

/**
 * What the first version of the field builder called things.
 *
 * Documents saved before the vocabulary lined up with the engine are still in the
 * database, and a field silently becoming `text` would stop it being read back — a
 * downgrade nobody asked for and nobody would see until a call went wrong.
 */
const LEGACY: Readonly<Record<string, string>> = {
  identifier: "reference",
  number: "quantity",
};

const DEFAULT_ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;

const clampAttempts = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_ATTEMPTS;
  return Math.min(MAX_ATTEMPTS, Math.max(1, Math.trunc(raw)));
};

const toKind = (raw: string): string => {
  const mapped = LEGACY[raw] ?? raw;
  return KINDS.has(mapped) ? mapped : "text";
};

/**
 * One entry, or null when it is not usable.
 *
 * `key` is the only part that cannot be defaulted: it is how a tool receives the value and
 * how the agent refers to it, so an entry without one describes nothing. Everything else
 * falls back to the safest reading — captured by speech, unconfirmed, not required —
 * because a half-written field should ask for less than was intended rather than more.
 */
const toField = (raw: unknown): CollectedField | null => {
  if (!isRecord(raw)) return null;
  const key = text(raw["key"]).trim();
  if (key === "") return null;

  const capture = text(raw["capture"]);
  const confirm = text(raw["confirm"]);
  const type = text(raw["type"]);

  return {
    key,
    type: toKind(type),
    prompt: text(raw["prompt"]).trim(),
    capture: ROUTES.has(capture) ? (capture as CaptureRoute) : "speech",
    confirm: CONFIRMATIONS.has(confirm) ? (confirm as Confirmation) : "none",
    required: raw["required"] === true,
    pattern: text(raw["pattern"]).trim(),
    // Clamped rather than trusted: the API bounds it, and a document written by hand in
    // psql does not go through the API. Zero attempts would escalate before asking.
    attempts: clampAttempts(raw["attempts"]),
  };
};

/**
 * Order is preserved, because order is the conversation.
 *
 * Dropped entries are logged with the agent rather than counted silently: the fix is a new
 * configuration, and whoever wrote it is the only person who can make it.
 */
export const parseCapturedFields = (
  raw: unknown,
  context: { readonly agentId: string | null; readonly log: Logger },
): readonly CollectedField[] => {
  if (!Array.isArray(raw)) return [];

  const fields: CollectedField[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const field = toField(entry);
    if (field === null) dropped += 1;
    else fields.push(field);
  }

  if (dropped > 0) {
    context.log.error("agent has unusable captured-field entries; those fields are skipped", {
      agentId: context.agentId,
      dropped,
      kept: fields.length,
    });
  }
  return fields;
};

/**
 * The stored graph, read once at configuration load and never on the answer path.
 *
 * Same contract as `parseCapturedFields` above and for the same reasons: it is the same kind
 * of stored document, it must never throw, and a call must not be parsing anything per turn.
 *
 * It is checked even though the publish gate already refused a graph with blocking problems.
 * The gate covers what arrived through the API; a row edited by hand, restored from a backup
 * taken before a schema change, or written by an older build did not go through it. The cost
 * of being wrong here is not an error message — it is a director that walks into a node with
 * no way out and stops asking, which the caller hears as the agent going quiet.
 *
 * Refusing returns null, which the caller reads as "conduct this call with the list". That is
 * the whole reason this returns rather than throws: a configuration problem must degrade into
 * a call that still talks (R6.2), never into one that does not.
 */
export const readStoredFlow = (
  raw: unknown,
  agentId: string | null,
  log: Logger,
): Flow | null => {
  if (raw === null || typeof raw !== "object") return null;

  const candidate = raw as { readonly nodes?: unknown; readonly edges?: unknown };
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    log.error("stored flow is not a graph", { agentId });
    return null;
  }

  const flow = raw as Flow;
  const blocking = validateFlow(flow).filter((problem) => problem.blocking);
  if (blocking.length > 0) {
    /* Error rather than warn. A published graph should not be able to reach this, so getting
       here means something wrote past the gate — and the agent is about to answer calls with
       its questions silently missing. */
    log.error("stored flow cannot conduct a call, falling back to the form", {
      agentId,
      problems: blocking.map((problem) => problem.code),
    });
    return null;
  }
  return flow;
};
