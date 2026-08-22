import { randomUUID } from "node:crypto";

import { forSpeech } from "@ansa/normalizer";
import { asCallId, createLogger, type OrganizationId } from "@ansa/shared";
import {
  createToolDispatcher,
  createToolRegistry,
  prepareConnectors,
  type DispatchOutcome,
  type IdentityGate,
  type RiskTier,
  type ToolArgs,
} from "@ansa/tools";

/**
 * Firing one of an organisation's own tools with arguments they chose, and showing them
 * the three things a caller's turn is actually made of.
 *
 * **It goes through the real dispatch path.** `prepareConnectors` builds the registry the
 * call path builds, from the same stored document, and `createToolDispatcher` runs it —
 * so the risk tiers, the three-second ceiling, the identity gate, the summariser and the
 * R5.4.3 check on its output are the ones a caller gets, not a description of them. There
 * is no second execution route here and there must not be: `packages/tools/src/dispatch.ts`
 * is the only call site of `adapter.execute` in the repository and a test enforces it.
 *
 * The consequence a organization meets immediately is that **a write tool does not fire**. It
 * comes back as `confirm` with the readback the caller would have heard, because that is
 * what the dispatcher does with a write nobody has said yes to yet, and an `irreversible`
 * tool comes back as `transfer`. A sandbox that ran them anyway would be teaching an
 * organisation something false about their own configuration — and the first time they
 * found out otherwise would be a caller's policy being cancelled during a test.
 *
 * **Why the raw response is worth a field.** R5.4.3 is the rule that raw JSON is never
 * spoken, and the summariser is a template the organization wrote against a shape they believe
 * their endpoint returns. When those disagree the template renders its fallback, the agent
 * says "I cannot find that policy", and nothing anywhere reports that the lookup in fact
 * succeeded and the field was called `status` rather than `state`. Putting the JSON beside
 * the sentence is the whole point of this endpoint.
 *
 * Three things a run deliberately does not carry, each of which belongs to a call:
 *
 *   - **No holding speech.** There is no audio, so there is nothing to cover. The
 *     scheduler's behaviour is Slice 5's and is tested there.
 *   - **No circuit breaker.** The live breaker is per process and shared across calls; a
 *     sandbox run neither trips it nor is refused by it, so testing a tool cannot take it
 *     away from callers and a tool that is currently failing on calls can still be examined.
 *   - **No call.** The call id below is synthetic and exists because the dispatcher logs
 *     one. Nothing correlates it to a row in `calls`, because there is no call.
 */

/**
 * The dispatcher logs against this and the confirmation store keys on it. It is not a call
 * and is never written anywhere a `calls` row is expected — a sandbox run that appeared in
 * an organisation's call history would corrupt every quality figure computed over it.
 */
const sandboxCallId = () => asCallId(`sandbox-${randomUUID()}`);

const log = createLogger({ component: "tool-sandbox" });

export interface SandboxRun {
  /**
   * Whose tools these are. Called `owner` for the reason `refusals.ts` gives: it goes into
   * a registry key and a vault's authentication tag, never into a query.
   */
  readonly owner: OrganizationId;
  /** The `tool_config` column, exactly as stored. */
  readonly toolConfig: unknown;
  readonly sealedCredentials: ReadonlyMap<string, string>;
  readonly credentialKey: Buffer | null;
  readonly name: string;
  readonly args: ToolArgs;
  /**
   * Call facts the organization is asserting the caller had confirmed, as `fact` to value.
   *
   * A tool that identifies a person by an argument will not run until the caller has
   * confirmed that detail, and the sandbox has no caller. Rather than exempt it — which
   * would make the one gate that exists because of a measured transcription failure the one
   * gate the sandbox lies about — the organization states the confirmation themselves, and the
   * dispatcher still checks the argument against it. Assert nothing and the run comes back
   * as `unconfirmed-identity`, which is also the right answer to see.
   */
  readonly confirmed: ReadonlyMap<string, string>;
}

export interface SandboxResult {
  readonly tool: string;
  /** Null only for a tool the dispatcher could not resolve, which this refuses earlier. */
  readonly riskTier: RiskTier | null;
  readonly outcome: DispatchOutcome["kind"];
  /**
   * What the endpoint returned, as JSON. Null when nothing ran — a refused tier, a timeout,
   * an unreachable host — which is exactly the set of cases where there is nothing to show.
   */
  readonly raw: string | null;
  /** The summariser's sentence, or the readback, or the transfer line, or the apology. */
  readonly summary: string;
  /** The same sentence after the normalizer, which is what the caller would hear. */
  readonly speech: string;
  /** Why it failed, or why an irreversible tool needs a person. Null when neither. */
  readonly reason: string | null;
  /** `http` or `mcp`. Null unless the tool actually ran. */
  readonly route: string | null;
  readonly latencyMs: number;
}

/** JSON that cannot be produced is reported as absent rather than as an exception. */
const asJson = (value: unknown): string | null => {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
};

const reasonOf = (outcome: DispatchOutcome): string | null => {
  if (outcome.kind === "failed") return outcome.reason;
  if (outcome.kind === "transfer") return outcome.reason;
  return null;
};

/**
 * Runs one tool. Null when this organisation has no tool by that name.
 *
 * Null rather than a `failed` outcome with `unknown-tool`, because the two are different
 * questions asked by different people: on a call it is the model having invented a tool and
 * the caller is owed a sentence, and here it is a name in a URL that does not exist and the
 * caller is owed a 404. The dispatcher would answer with an apology, which is not an answer
 * to "does this tool exist".
 */
export const runToolInSandbox = async (run: SandboxRun): Promise<SandboxResult | null> => {
  // The same preparation the call path does — parse, drop what has no credential, build the
  // egress guard, discover MCP tools — rather than a second one that would drift from it.
  const prepared = await prepareConnectors({
    organizationId: run.owner,
    config: run.toolConfig,
    credentialKey: run.credentialKey,
    sealedCredentials: run.sealedCredentials,
    log,
  });

  /**
   * The organization's own tools and nothing else.
   *
   * `CALL_CONTROL_DEFINITIONS` are deliberately absent: `end_call` and `transfer_to_human`
   * close over the effects of a call in progress, and there is no call. A registry holding
   * stubs of them would let somebody "test" a hangup and be told it worked.
   */
  const registry = createToolRegistry();
  prepared.register(registry);
  if (registry.resolve(run.owner, run.name) === null) return null;

  let raw: unknown;
  let ran = false;
  const identity: IdentityGate = { confirmed: (fact) => run.confirmed.get(fact) ?? null };

  const dispatcher = createToolDispatcher({
    registry,
    log,
    identity,
    onResult: (_call, result) => {
      raw = result;
      ran = true;
    },
  });

  const outcome = await dispatcher.dispatch({
    organizationId: run.owner,
    callId: sandboxCallId(),
    /*
     * Inbound, and it is a fiction — there is no call here at all.
     *
     * The dispatcher refuses `write` tools on outbound calls because an outbound recipient
     * cannot establish who they are. Neither half of that applies to a sandbox run: there is
     * no recipient, and the person triggering it is the organisation itself, already
     * authenticated by their session and acting on their own tools.
     *
     * Saying "outbound" to be cautious would be the worse answer, not the safer one. It
     * would make every write tool untestable from the console — the operator would see a
     * refusal written for a customer rather than their tool's behaviour — and the first
     * time anybody met the real refusal would be on a real call to a real person.
     */
    direction: "inbound",
    name: run.name,
    args: run.args,
  });

  return {
    tool: outcome.name,
    riskTier: outcome.tier,
    outcome: outcome.kind,
    // `ran` and not `raw !== undefined`: an endpoint that legitimately returned nothing —
    // a 404 the organization's `speech.fallback` is written for — must not read as a tool that
    // never got that far.
    raw: ran ? asJson(raw) : null,
    summary: outcome.speech,
    // The normalizer, because nothing reaches TTS unnormalized and a summary containing a
    // naira amount or a policy number is spoken differently from how it reads.
    speech: forSpeech(outcome.speech),
    reason: reasonOf(outcome),
    route: outcome.kind === "ok" ? outcome.route : null,
    latencyMs: outcome.latencyMs,
  };
};
