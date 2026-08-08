import { describe, expect, it } from "vitest";

import { advance, idle, type CaptureState } from "../capture";
import {
  CALL_STATES,
  createCallState,
  type CallEvent,
  type CallState,
  type CallStateMachine,
  type CallTransition,
} from "./machine";

/**
 * Every state the suite has reached. Asserted at the end, so a state that becomes
 * unreachable is a failing test rather than something nobody notices.
 */
const reached = new Set<CallState>();

const machine = (): CallStateMachine => {
  const seen: CallTransition[] = [];
  const call = createCallState((t) => seen.push(t));
  reached.add(call.state);
  return {
    get state() {
      reached.add(call.state);
      return call.state;
    },
    apply(event: CallEvent) {
      const t = call.apply(event);
      reached.add(call.state);
      return t;
    },
  };
};

/** The greeting, played and heard: the state every ordinary call starts from. */
const greeted = (): CallStateMachine => {
  const call = machine();
  call.apply({ kind: "agent.turn.started", seq: 1, reason: "greeting" });
  call.apply({ kind: "agent.audio.started", seq: 1 });
  call.apply({ kind: "agent.turn.completed", seq: 1 });
  return call;
};

/** A caller turn that has ended and is waiting to be understood. */
const callerFinished = (): CallStateMachine => {
  const call = greeted();
  call.apply({ kind: "caller.speech.started", handling: "barge-in" });
  call.apply({ kind: "caller.turn.ended" });
  return call;
};

const speak = (state: CaptureState, text: string): CaptureState =>
  advance(state, { kind: "speech", text }).state;

const press = (state: CaptureState, digit: string): CaptureState =>
  advance(state, { kind: "keypad", digit }).state;

/** Drives capture with real caller speech and reports each step to the machine. */
const capturing = (call: CallStateMachine) => {
  let state: CaptureState = idle;
  return {
    get capture(): CaptureState {
      return state;
    },
    said(text: string): CallState {
      const previous = state;
      state = speak(state, text);
      call.apply({ kind: "capture.updated", previous, next: state });
      return call.state;
    },
    pressed(digit: string): CallState {
      const previous = state;
      state = press(state, digit);
      call.apply({ kind: "capture.updated", previous, next: state });
      return call.state;
    },
    /** What captureHandled does the moment a value is released: capture goes back to idle. */
    released(): CallState {
      const previous = state;
      state = idle;
      call.apply({ kind: "capture.updated", previous, next: state });
      return call.state;
    },
  };
};

describe("opening the call", () => {
  it("is IDLE before the greeting turn exists", () => {
    expect(machine().state).toBe("IDLE");
  });

  it("is GREETING from the moment the greeting turn is opened, cached audio or not", () => {
    // The pre-rendered path sets sentenceAudioAt in the same breath as the turn; the live
    // path waits for the first synthesised byte. Both are GREETING, because the caller
    // cannot tell and neither can anything downstream.
    const cached = machine();
    cached.apply({ kind: "agent.turn.started", seq: 1, reason: "greeting" });
    cached.apply({ kind: "agent.audio.started", seq: 1 });
    expect(cached.state).toBe("GREETING");

    const live = machine();
    live.apply({ kind: "agent.turn.started", seq: 1, reason: "greeting" });
    expect(live.state).toBe("GREETING");
  });

  it("listens once the greeting has played out", () => {
    expect(greeted().state).toBe("LISTENING");
  });

  it("listens when the caller talks over the greeting", () => {
    const call = machine();
    call.apply({ kind: "agent.turn.started", seq: 1, reason: "greeting" });
    call.apply({ kind: "agent.audio.started", seq: 1 });
    call.apply({ kind: "caller.speech.started", handling: "barge-in" });
    // stopSpeaking has not run yet: the agent still owns the turn.
    expect(call.state).toBe("GREETING");
    call.apply({ kind: "agent.turn.interrupted", seq: 1, reason: "caller interrupted" });
    expect(call.state).toBe("LISTENING");
  });
});

describe("an ordinary turn", () => {
  it("goes UNDERSTANDING, PROCESSING, RESPONDING, LISTENING", () => {
    const call = greeted();
    call.apply({ kind: "caller.speech.started", handling: "barge-in" });
    expect(call.state).toBe("LISTENING");

    call.apply({ kind: "caller.turn.ended" });
    expect(call.state).toBe("UNDERSTANDING");

    call.apply({ kind: "caller.turn.dispatched" });
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    // The model is writing and nothing has been said. This is the gap the fillers cover
    // and the gap in which the orchestrator refuses to treat speech as an interruption.
    expect(call.state).toBe("PROCESSING");

    call.apply({ kind: "agent.audio.started", seq: 2 });
    expect(call.state).toBe("RESPONDING");

    call.apply({ kind: "agent.turn.completed", seq: 2 });
    expect(call.state).toBe("LISTENING");
  });

  it("stays PROCESSING when the caller speaks before the agent has made a sound", () => {
    // orchestrator.ts refuses to tear down a turn that has produced no audio: the dead
    // air would otherwise manufacture the interruption that deletes the answer.
    const call = greeted();
    call.apply({ kind: "caller.turn.ended" });
    call.apply({ kind: "caller.turn.dispatched" });
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    call.apply({ kind: "caller.speech.started", handling: "over-thinking" });
    expect(call.state).toBe("PROCESSING");
  });

  it("does not treat our own audio coming back as the caller speaking", () => {
    const call = greeted();
    call.apply({ kind: "caller.turn.ended" });
    call.apply({ kind: "caller.turn.dispatched" });
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    call.apply({ kind: "agent.audio.started", seq: 2 });
    expect(call.apply({ kind: "caller.speech.started", handling: "echo" })).toBeNull();
    expect(call.state).toBe("RESPONDING");
  });

  it("stays RESPONDING when a repeat or a capture prompt is being synthesised", () => {
    for (const reason of ["repeat", "capture"] as const) {
      const call = greeted();
      call.apply({ kind: "agent.turn.started", seq: 2, reason });
      expect(call.state).toBe("PROCESSING");
      call.apply({ kind: "agent.audio.started", seq: 2 });
      expect(call.state).toBe("RESPONDING");
    }
  });
});

describe("transcripts that go nowhere", () => {
  it("stays UNDERSTANDING through every kind of discard", () => {
    // Not one of these changes an orchestrator variable. The call is still waiting for a
    // transcript worth answering, and the watchdog it armed is still the only thing that
    // will rescue it.
    const reasons = [
      "no-speech",
      "noise",
      "echo",
      "backchannel",
      "particle",
      "self-speech",
    ] as const;
    for (const reason of reasons) {
      const call = callerFinished();
      expect(call.apply({ kind: "caller.transcript.discarded", reason })).toBeNull();
      expect(call.state, reason).toBe("UNDERSTANDING");
    }
  });

  it("recovers when the transcript never arrives at all", () => {
    const call = callerFinished();
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "recovery" });
    expect(call.state).toBe("ERROR_RECOVERY");
    call.apply({ kind: "agent.audio.started", seq: 2 });
    expect(call.state).toBe("ERROR_RECOVERY");
    call.apply({ kind: "agent.turn.completed", seq: 2 });
    expect(call.state).toBe("LISTENING");
  });

  it("goes back to LISTENING when the caller simply starts again", () => {
    const call = callerFinished();
    call.apply({ kind: "caller.speech.started", handling: "barge-in" });
    expect(call.state).toBe("LISTENING");
  });
});

describe("a turn held for the continuation", () => {
  it("is UNDERSTANDING, not LISTENING, while the wait runs", () => {
    // "my name is" with nothing after it. The agent is deliberately silent and that
    // silence must not read as a call with nothing happening in it.
    const call = callerFinished();
    call.apply({ kind: "caller.turn.held" });
    expect(call.state).toBe("UNDERSTANDING");

    call.apply({ kind: "caller.turn.dispatched" });
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    expect(call.state).toBe("PROCESSING");
  });

  it("does not disturb a turn the agent is already speaking", () => {
    // A transcript can arrive mid-reply and be held. The agent keeps talking, exactly as
    // it does today.
    const call = greeted();
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    call.apply({ kind: "agent.audio.started", seq: 2 });
    call.apply({ kind: "caller.turn.held" });
    expect(call.state).toBe("RESPONDING");
  });
});

describe("capture, driven by the real capture machine", () => {
  it("reads a number back and confirms it", () => {
    const call = greeted();
    const capture = capturing(call);

    expect(capture.said("My policy number is four one seven")).toBe("CONFIRMING_ENTITY");
    // The readback is being spoken, and the state stays CONFIRMING_ENTITY throughout: what
    // makes the caller's next turn a yes or a no is not over until they answer.
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "capture" });
    call.apply({ kind: "agent.audio.started", seq: 2 });
    expect(call.state).toBe("CONFIRMING_ENTITY");
    call.apply({ kind: "agent.turn.completed", seq: 2 });
    expect(call.state).toBe("CONFIRMING_ENTITY");

    // `confirmed` names the same state as `idle`, deliberately: the value is captured and
    // capture is over. captureHandled reports both — the confirmed state and the reset to
    // idle on the next line — and only one transition comes out.
    expect(capture.said("Yes, that's correct")).toBe("LISTENING");
    expect(capture.capture).toMatchObject({ kind: "confirmed", value: "417" });
    expect(capture.released()).toBe("LISTENING");
  });

  it("waits for a correction when there is nothing better to offer", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    // "No" with no replacement. capture.ts asks again — "Sorry — once more, slowly?" —
    // which is a request for the value, not for a yes or a no.
    expect(capture.said("No")).toBe("WAITING_FOR_CORRECTION");
  });

  it("goes back to confirming when the caller corrects the value in the same breath", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    // "No, it's four one eight" is a new candidate, read back rather than trusted. The
    // caller is being asked yes or no again, so this is not a correction wait.
    expect(capture.said("No, it's four one eight")).toBe("CONFIRMING_ENTITY");
    expect(capture.capture).toMatchObject({ kind: "confirming", value: "418" });
  });

  it("captures on the keypad after speech has failed twice", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    expect(capture.said("No")).toBe("WAITING_FOR_CORRECTION");
    expect(capture.said("No")).toBe("CAPTURING_ENTITY");
    expect(capture.capture.kind).toBe("keypad");

    // Digits accumulating is capture, not correction.
    expect(capture.pressed("4")).toBe("CAPTURING_ENTITY");
    expect(capture.pressed("1")).toBe("CAPTURING_ENTITY");
    // Hash releases the value: keypad tones are unambiguous and there is no readback.
    expect(capture.pressed("#")).toBe("LISTENING");
    expect(capture.capture).toMatchObject({ kind: "confirmed", value: "41" });
    expect(capture.released()).toBe("LISTENING");
  });

  it("waits for a correction when the caller talks instead of typing", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    capture.said("No");
    capture.said("No");
    expect(capture.capture.kind).toBe("keypad");
    expect(capture.said("I already told you")).toBe("WAITING_FOR_CORRECTION");
  });

  it("spells a name rather than offering the keypad", () => {
    const call = greeted();
    const capture = capturing(call);
    expect(capture.said("My name is Hill")).toBe("CONFIRMING_ENTITY");
    // There is no key for a name, so a rejected name goes straight to spelling.
    expect(capture.said("No")).toBe("CAPTURING_ENTITY");
    expect(capture.capture.kind).toBe("spelling");
    expect(capture.said("K for Kano, I for India, M for Mali")).toBe("CONFIRMING_ENTITY");
    expect(capture.capture).toMatchObject({ kind: "confirming", value: "Kim" });
  });

  it("keeps waiting when the spelling reproduces the value the caller rejected", () => {
    // capture.ts refuses to offer a rejected value back, so a caller who spells out the
    // same thing the transcriber already got wrong is asked again rather than looped.
    const call = greeted();
    const capture = capturing(call);
    capture.said("My name is Hill");
    capture.said("No");
    expect(capture.said("H for Hotel, I for India, L, L")).toBe("WAITING_FOR_CORRECTION");
  });

  it("asks for the spelling again before giving up", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("My name is Hill");
    capture.said("No");
    expect(capture.said("I do not want to spell it")).toBe("WAITING_FOR_CORRECTION");
    expect(capture.said("I said no")).toBe("TRANSFERRING");
  });

  it("transfers when the caller cannot get the value across at all", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    capture.said("No");
    capture.said("No");
    capture.said("I already told you");
    expect(capture.said("This is ridiculous")).toBe("TRANSFERRING");
  });

  it("transfers on an empty keypad entry", () => {
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    capture.said("No");
    capture.said("No");
    expect(capture.pressed("#")).toBe("TRANSFERRING");
  });

  it("stays TRANSFERRING however many turns the caller takes", () => {
    // Recorded, not endorsed. Once capture escalates, orchestrator.ts swallows every
    // caller turn for the rest of the call and the agent never speaks again — see the
    // "known wrong" section of WIRING.md. The machine reports what happens.
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    capture.said("No");
    capture.said("No");
    capture.said("I already told you");
    capture.said("This is ridiculous");
    expect(capture.said("Hello? Are you there?")).toBe("TRANSFERRING");
    expect(capture.said("Can you hear me?")).toBe("TRANSFERRING");
  });

  it("lets a recovery line outrank an outstanding readback", () => {
    // The recovery line is what the caller is hearing right now, and it is the more
    // useful thing to see in a log than the readback still waiting behind it.
    const call = greeted();
    const capture = capturing(call);
    capture.said("four one seven");
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "recovery" });
    expect(call.state).toBe("ERROR_RECOVERY");
    call.apply({ kind: "agent.turn.completed", seq: 2 });
    expect(call.state).toBe("CONFIRMING_ENTITY");
  });
});

describe("ending", () => {
  it("is ENDING between the hang-up and the socket closing", () => {
    const call = greeted();
    call.apply({ kind: "call.hangup.requested", reason: "tts failed twice" });
    expect(call.state).toBe("ENDING");
    call.apply({ kind: "call.closed", reason: "completed" });
    expect(call.state).toBe("ENDED");
  });

  it("ends without a hang-up when the caller puts the phone down", () => {
    const call = greeted();
    call.apply({ kind: "call.closed", reason: "caller hung up" });
    expect(call.state).toBe("ENDED");
  });

  it("ignores everything after the call has closed", () => {
    // Late callbacks are normal on this path: a synthesis that was in flight, a mark the
    // carrier had already sent. None of them may resurrect a finished call.
    const call = greeted();
    call.apply({ kind: "call.closed", reason: "caller hung up" });
    expect(call.apply({ kind: "agent.turn.started", seq: 9, reason: "model" })).toBeNull();
    expect(call.apply({ kind: "agent.audio.started", seq: 9 })).toBeNull();
    expect(call.apply({ kind: "caller.turn.ended" })).toBeNull();
    expect(call.state).toBe("ENDED");
  });

  it("ends the call when the listener dies mid-recovery", () => {
    const call = greeted();
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "recovery" });
    call.apply({ kind: "agent.audio.started", seq: 2 });
    call.apply({ kind: "call.hangup.requested", reason: "listen connection lost" });
    expect(call.state).toBe("ENDING");
  });
});

describe("events that must not move the state", () => {
  it("ignores audio and completion for a turn that has been superseded", () => {
    const call = greeted();
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    call.apply({ kind: "agent.audio.started", seq: 2 });
    call.apply({ kind: "agent.turn.interrupted", seq: 2, reason: "superseded by caller turn" });
    call.apply({ kind: "agent.turn.started", seq: 3, reason: "model" });

    // The old turn's synthesis is still unwinding. Every callback in orchestrator.ts
    // carries the same `turn?.seq !== current.seq` guard, and so does this.
    expect(call.apply({ kind: "agent.audio.started", seq: 2 })).toBeNull();
    expect(call.apply({ kind: "agent.turn.completed", seq: 2 })).toBeNull();
    expect(call.state).toBe("PROCESSING");
  });

  it("ignores an interruption when nothing is playing", () => {
    // stopSpeaking is called from paths that may find no turn at all and returns early.
    const call = greeted();
    expect(call.apply({ kind: "agent.turn.interrupted", seq: 1, reason: "call ended" })).toBeNull();
    expect(call.state).toBe("LISTENING");
  });

  it("reports a transition only when the named state actually changes", () => {
    const call = greeted();
    call.apply({ kind: "agent.turn.started", seq: 2, reason: "model" });
    const first = call.apply({ kind: "agent.audio.started", seq: 2 });
    expect(first).toEqual({
      from: "PROCESSING",
      to: "RESPONDING",
      event: "agent.audio.started",
    });
    expect(call.apply({ kind: "agent.audio.started", seq: 2 })).toBeNull();
  });
});

describe("the state list itself", () => {
  it("reaches every state the call can be in", () => {
    const unreached = CALL_STATES.filter((state) => !reached.has(state));
    // ON_HOLD is the only exception and it is deliberate: Ansa has never put a caller on
    // hold. If this list ever grows, either the suite is missing a case or a state is
    // inventory nothing produces.
    expect(unreached).toEqual(["ON_HOLD"]);
  });

  it("has no duplicates", () => {
    expect(new Set(CALL_STATES).size).toBe(CALL_STATES.length);
  });
});
