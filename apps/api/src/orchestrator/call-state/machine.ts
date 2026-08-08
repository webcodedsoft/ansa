import type { CaptureState } from "../capture";

/**
 * The call's state, as one named value.
 *
 * This machine does not invent a flow. Every state below is a condition orchestrator.ts
 * already reaches, expressed today as `turn`, `capture`, `pending` and a handful of
 * booleans that no two readers agree on. Nothing here decides anything: the orchestrator
 * still owns every decision it owns now, and reports what it did. Adopting it is a
 * refactor with no behaviour change — see WIRING.md for the exact, ordered edits.
 *
 * The mapping to the real code, condition by condition:
 *
 * | State                  | What is true in orchestrator.ts                              |
 * |------------------------|--------------------------------------------------------------|
 * | IDLE                   | runConversation has been entered; the greeting turn does not yet exist |
 * | GREETING               | `turn` is the greeting turn                                  |
 * | LISTENING              | `turn === null`, nothing held, no capture, no end-of-turn outstanding |
 * | UNDERSTANDING          | end-of-turn seen and no reply started, or a turn held for a continuation (`pending`) |
 * | RESPONDING             | `turn !== null` and audio for it has begun                   |
 * | PROCESSING             | `turn !== null` and no byte has left the box yet             |
 * | CAPTURING_ENTITY       | `capture.kind` is `spelling` or `keypad`, first ask          |
 * | CONFIRMING_ENTITY      | `capture.kind === "confirming"` — a readback is outstanding  |
 * | WAITING_FOR_CORRECTION | capture asked again for the same thing after the caller failed to supply it |
 * | TRANSFERRING           | `capture.kind === "escalate"`                                |
 * | ON_HOLD                | *nothing*. See the note below.                               |
 * | ENDING                 | `stream.hangUp()` called, `onClosed` not yet fired           |
 * | ENDED                  | `stream.onClosed` fired                                      |
 * | ERROR_RECOVERY         | `turn` is a recovery turn (sayRecovery)                      |
 *
 * ON_HOLD is unreachable and is declared because the charter names it. Ansa has never
 * put a caller on hold: there is no hold, no music, no resume. The thinking gap that
 * looks like one is PROCESSING, and the holding *speech* that covers it is a filler, not
 * a hold. When a real hold exists it gets an event and this comment goes; until then a
 * state nothing can reach is honest inventory, and the test file asserts it stays
 * unreachable so the two cannot drift apart quietly.
 */
export type CallState =
  | "IDLE"
  | "GREETING"
  | "LISTENING"
  | "UNDERSTANDING"
  | "RESPONDING"
  | "PROCESSING"
  | "CAPTURING_ENTITY"
  | "CONFIRMING_ENTITY"
  | "WAITING_FOR_CORRECTION"
  | "TRANSFERRING"
  | "ON_HOLD"
  | "ENDING"
  | "ENDED"
  | "ERROR_RECOVERY";

/**
 * Every state, in the order above. Exported so a log consumer, the call viewer or a test
 * can enumerate them rather than keeping a second copy that rots.
 */
export const CALL_STATES: readonly CallState[] = [
  "IDLE",
  "GREETING",
  "LISTENING",
  "UNDERSTANDING",
  "RESPONDING",
  "PROCESSING",
  "CAPTURING_ENTITY",
  "CONFIRMING_ENTITY",
  "WAITING_FOR_CORRECTION",
  "TRANSFERRING",
  "ON_HOLD",
  "ENDING",
  "ENDED",
  "ERROR_RECOVERY",
];

/**
 * Why an agent turn was opened. One value per place orchestrator.ts constructs an
 * `AgentTurn`, and there are exactly five: the greeting, a model reply (respondTo), a
 * capture prompt (sayNow), a repeat (repeatLast) and a recovery line (sayRecovery).
 *
 * The reason is what separates GREETING and ERROR_RECOVERY from an ordinary turn. It is
 * not a policy input — nothing here reads it to decide anything the orchestrator does.
 */
export type AgentTurnReason = "greeting" | "model" | "capture" | "repeat" | "recovery";

/**
 * What the orchestrator did with a speech-start event, matching its three branches:
 *
 * - `echo`        — inside the barge-in guard, so it is our own audio coming back. The
 *                   orchestrator returns without touching the turn, and so does this.
 * - `over-thinking` — the caller spoke while the agent had a turn open but had made no
 *                   sound. The orchestrator deliberately does NOT tear the turn down.
 * - `barge-in`    — accepted. `stopSpeaking` follows, which reports its own event.
 */
export type SpeechHandling = "echo" | "over-thinking" | "barge-in";

/** Why a final transcript was dropped. One value per discard site in `onFinal`. */
export type DiscardReason =
  | "no-speech"
  | "noise"
  | "echo"
  | "backchannel"
  | "particle"
  | "self-speech";

export type CallEvent =
  | { readonly kind: "agent.turn.started"; readonly seq: number; readonly reason: AgentTurnReason }
  | { readonly kind: "agent.audio.started"; readonly seq: number }
  | { readonly kind: "agent.turn.completed"; readonly seq: number }
  | { readonly kind: "agent.turn.interrupted"; readonly seq: number; readonly reason: string }
  | { readonly kind: "caller.speech.started"; readonly handling: SpeechHandling }
  | { readonly kind: "caller.turn.ended" }
  | { readonly kind: "caller.transcript.discarded"; readonly reason: DiscardReason }
  | { readonly kind: "caller.turn.held" }
  | { readonly kind: "caller.turn.dispatched" }
  | {
      readonly kind: "capture.updated";
      readonly previous: CaptureState;
      readonly next: CaptureState;
    }
  | { readonly kind: "call.hangup.requested"; readonly reason: string }
  | { readonly kind: "call.closed"; readonly reason: string };

export interface CallTransition {
  readonly from: CallState;
  readonly to: CallState;
  readonly event: CallEvent["kind"];
}

/**
 * The orchestrator's own variables, mirrored.
 *
 * Deliberately not a prettier model. Each field is one thing orchestrator.ts already
 * tracks, so the derivation below can be checked against the file line by line. A
 * cleaner set of facts would be a redesign, and a redesign cannot be proved to change
 * no behaviour.
 */
interface CallFacts {
  /** `opening` is before the greeting turn exists; `hanging-up` is after `stream.hangUp()`. */
  readonly lifecycle: "opening" | "open" | "hanging-up" | "closed";
  /** `turn`, with the two fields that change what the call is doing. */
  readonly agent: {
    readonly seq: number;
    readonly reason: AgentTurnReason;
    /** `turn.sentenceAudioAt !== null`: a byte has reached the carrier for this turn. */
    readonly audioStarted: boolean;
  } | null;
  readonly capture: CaptureState;
  /** The last capture step asked again for something the caller had already been asked for. */
  readonly correcting: boolean;
  /** A speech-start has been accepted and no end-of-turn has followed. */
  readonly callerSpeaking: boolean;
  /** End-of-turn seen; no transcript has been acted on since. `pending`'s sibling. */
  readonly callerFinished: boolean;
  /** `pending !== null`: a turn that ended mid-thought, held for the continuation. */
  readonly awaitingContinuation: boolean;
}

const initialFacts: CallFacts = {
  lifecycle: "opening",
  agent: null,
  capture: { kind: "idle" },
  correcting: false,
  callerSpeaking: false,
  callerFinished: false,
  awaitingContinuation: false,
};

/**
 * Whether a capture step re-asked for something the caller has already been asked for.
 *
 * This is the whole of WAITING_FOR_CORRECTION, and it is derived from capture.ts's own
 * branches rather than from the wording of the prompt:
 *
 * - `confirming` with the value unchanged and the rejected list one longer is the `retry`
 *   branch — "Sorry — once more, slowly?". There is nothing better to offer, so the
 *   agent is waiting for a replacement value, not for a yes or no.
 * - `spelling` or `keypad` with the attempt raised is the re-prompt: the caller answered
 *   with something that was neither a spelling nor a keypress.
 *
 * Everything else in `confirming` is a readback and belongs in CONFIRMING_ENTITY, including
 * a fresh candidate read back after a rejection — the caller is being asked yes or no
 * about a value, which is a different question from "say it again".
 */
const isReAsk = (previous: CaptureState, next: CaptureState): boolean => {
  if (next.kind === "confirming") {
    return (
      previous.kind === "confirming" &&
      next.value === previous.value &&
      next.rejected.length > previous.rejected.length
    );
  }
  if (next.kind === "spelling") {
    return previous.kind === "spelling" && next.attempt > previous.attempt;
  }
  if (next.kind === "keypad") {
    return previous.kind === "keypad" && next.attempt > previous.attempt;
  }
  return false;
};

/**
 * The named state, from the facts. Order is precedence and every step of it is a claim
 * about the real code:
 *
 * 1. The lifecycle outranks everything. A closed call is not confirming anything.
 * 2. The greeting and a recovery line outrank capture, because both are transient turns
 *    the caller is hearing right now and both are more informative than the readback
 *    still outstanding behind them.
 * 3. Capture outranks an ordinary agent turn. While a readback is playing the state is
 *    CONFIRMING_ENTITY, not RESPONDING — that is what makes the caller's next turn a yes
 *    or no, and it is exactly the gate `captureHandled` applies before the model runs.
 *    It also means the state does not flicker between CONFIRMING_ENTITY and RESPONDING
 *    while the readback plays out.
 * 4. An agent turn outranks the caller. If both are talking, the agent's turn is the
 *    thing that gets torn down, so it is the thing worth naming.
 */
const stateOf = (facts: CallFacts): CallState => {
  if (facts.lifecycle === "closed") return "ENDED";
  if (facts.lifecycle === "hanging-up") return "ENDING";
  if (facts.lifecycle === "opening") return "IDLE";

  if (facts.agent !== null && facts.agent.reason === "greeting") return "GREETING";
  if (facts.agent !== null && facts.agent.reason === "recovery") return "ERROR_RECOVERY";

  if (facts.capture.kind === "escalate") return "TRANSFERRING";
  if (facts.capture.kind === "confirming") {
    return facts.correcting ? "WAITING_FOR_CORRECTION" : "CONFIRMING_ENTITY";
  }
  if (facts.capture.kind === "spelling" || facts.capture.kind === "keypad") {
    return facts.correcting ? "WAITING_FOR_CORRECTION" : "CAPTURING_ENTITY";
  }
  // `confirmed` is deliberately not listed. The orchestrator replaces it with `idle` on
  // the same line it reads the value, so it never survives a turn; treating it as capture
  // still being engaged would name a state the call is not in.

  if (facts.agent !== null) return facts.agent.audioStarted ? "RESPONDING" : "PROCESSING";

  // The caller has the floor. Above the two waits below because a caller who has started
  // speaking again is no longer someone we are waiting on.
  if (facts.callerSpeaking) return "LISTENING";
  if (facts.awaitingContinuation || facts.callerFinished) return "UNDERSTANDING";
  return "LISTENING";
};

const applyTo = (facts: CallFacts, event: CallEvent): CallFacts => {
  // Any event at all means the call has begun. IDLE is only the gap between constructing
  // the conversation and opening the greeting turn, which is microseconds on a real call
  // and is worth naming only so that "the state is always a named value" is true from the
  // first line of runConversation rather than from the greeting onwards.
  const lifecycle = facts.lifecycle === "opening" ? "open" : facts.lifecycle;
  const open: CallFacts = { ...facts, lifecycle };

  switch (event.kind) {
    case "agent.turn.started":
      return {
        ...open,
        agent: { seq: event.seq, reason: event.reason, audioStarted: false },
        // A reply is under way, so nothing is waiting on a transcript any more. Mirrors
        // respondTo replacing the transcript watchdog with its own.
        callerFinished: false,
      };

    case "agent.audio.started":
      // A stale sequence is ignored, the same guard every synthesis callback carries.
      if (open.agent === null || open.agent.seq !== event.seq) return open;
      return {
        ...open,
        agent: { ...open.agent, audioStarted: true },
        callerFinished: false,
      };

    case "agent.turn.completed":
    case "agent.turn.interrupted":
      if (open.agent === null || open.agent.seq !== event.seq) return open;
      return { ...open, agent: null };

    case "caller.speech.started":
      // Echo is our own audio returning. The orchestrator returns without touching the
      // turn, and a state change here would claim a caller who never spoke.
      if (event.handling === "echo") return open;
      return { ...open, callerSpeaking: true };

    case "caller.turn.ended":
      return { ...open, callerSpeaking: false, callerFinished: true };

    case "caller.transcript.discarded":
      // Deliberately nothing. A discarded transcript changes no orchestrator variable:
      // the filler timers stay armed, the transcript watchdog stays armed, and the call
      // stays in UNDERSTANDING waiting for one that is real. Reported so the discard is
      // visible against the state it happened in.
      return open;

    case "caller.turn.held":
      return { ...open, callerSpeaking: false, awaitingContinuation: true };

    case "caller.turn.dispatched":
      return {
        ...open,
        callerSpeaking: false,
        callerFinished: false,
        awaitingContinuation: false,
      };

    case "capture.updated":
      return {
        ...open,
        capture: event.next,
        correcting: isReAsk(event.previous, event.next),
      };

    case "call.hangup.requested":
      return open.lifecycle === "closed" ? open : { ...open, lifecycle: "hanging-up" };

    case "call.closed":
      return {
        ...open,
        lifecycle: "closed",
        agent: null,
        callerSpeaking: false,
        callerFinished: false,
        awaitingContinuation: false,
      };
  }
};

export interface CallStateMachine {
  /** The call's state right now. One named value, always. */
  readonly state: CallState;
  /**
   * Reports something that happened. Returns the transition when the named state changed
   * and null when it did not, so the caller can log every transition and only those.
   *
   * Never throws. An event that makes no sense in the current state is ignored, because a
   * state machine that throws mid-call is worse than one that is briefly wrong.
   */
  apply(event: CallEvent): CallTransition | null;
}

export const createCallState = (
  onTransition?: (transition: CallTransition) => void,
): CallStateMachine => {
  let facts = initialFacts;
  let state: CallState = stateOf(facts);

  return {
    get state(): CallState {
      return state;
    },

    apply(event: CallEvent): CallTransition | null {
      // Terminal. A call that has closed cannot start speaking again, and a late
      // callback firing after hang-up must not resurrect it.
      if (facts.lifecycle === "closed") return null;

      facts = applyTo(facts, event);
      const next = stateOf(facts);
      if (next === state) return null;

      const transition: CallTransition = { from: state, to: next, event: event.kind };
      state = next;
      onTransition?.(transition);
      return transition;
    },
  };
};
