import { describe, expect, it } from "vitest";

import { advance, idle, type CaptureState } from "./capture";

const speak = (state: CaptureState, text: string) => advance(state, { kind: "speech", text });
const press = (state: CaptureState, digit: string) => advance(state, { kind: "keypad", digit });

describe("readback", () => {
  it("reads a spoken number back before it can be used", () => {
    const r = speak(idle, "My policy number is four one seven");
    expect(r.state.kind).toBe("confirming");
    // Nothing downstream may see the value yet. This is the whole requirement.
    expect(r.captured).toBeNull();
    expect(r.say).toContain("four one seven");
    expect(r.say).toContain("Is that correct?");
  });

  it("does nothing when the caller said no number at all", () => {
    const r = speak(idle, "I want to renew my cover");
    expect(r.state).toEqual(idle);
    expect(r.say).toBeNull();
  });

  it("releases the value only after the caller agrees", () => {
    const asked = speak(idle, "four one seven");
    const done = speak(asked.state, "Yes, that's correct");
    expect(done.state.kind).toBe("confirmed");
    expect(done.captured).toBe("417");
  });

  it("accepts the Nigerian forms of agreement", () => {
    for (const yes of ["na so", "correct", "exactly", "yeah", "that's right"]) {
      const asked = speak(idle, "four one seven");
      expect(speak(asked.state, yes).captured).toBe("417");
    }
  });

  it("takes a correction and a rejection said in one breath", () => {
    // "No, it's four one eight" is the normal way to correct a digit, and the correction
    // must not be lost to the rejection.
    const asked = speak(idle, "four one seven");
    const fixed = speak(asked.state, "No, it's four one eight");
    expect(fixed.state).toMatchObject({ kind: "confirming", value: "418" });
    expect(fixed.say).toContain("four one eight");
    // A correction is speech too, so it gets read back rather than trusted.
    expect(fixed.captured).toBeNull();
  });

  it("never releases a value on a bare rejection", () => {
    const asked = speak(idle, "four one seven");
    const rejected = speak(asked.state, "No");
    expect(rejected.captured).toBeNull();
    expect(rejected.state.kind).toBe("confirming");
  });

  it("offers the keypad after two failed spoken attempts, not sooner", () => {
    let state = speak(idle, "four one seven").state;
    state = speak(state, "No").state;
    expect(state.kind).toBe("confirming"); // still speech on attempt two

    const third = speak(state, "No");
    expect(third.state.kind).toBe("keypad");
    expect(third.say).toContain("keypad");
  });

  it("accepts keypad digits and confirms on hash", () => {
    let state: CaptureState = { kind: "keypad", digits: "", attempt: 0 };
    for (const d of "417") state = press(state, d).state;
    const done = press(state, "#");
    // Tones are unambiguous, so there is nothing a readback could catch.
    expect(done.captured).toBe("417");
  });

  it("lets star clear a mistyped entry", () => {
    let state: CaptureState = { kind: "keypad", digits: "", attempt: 0 };
    for (const d of "419") state = press(state, d).state;
    state = press(state, "*").state;
    for (const d of "417") state = press(state, d).state;
    expect(press(state, "#").captured).toBe("417");
  });

  it("escalates rather than looping when the keypad is not working either", () => {
    const empty: CaptureState = { kind: "keypad", digits: "", attempt: 0 };
    expect(press(empty, "#").state.kind).toBe("escalate");
  });

  it("escalates when the caller keeps talking instead of typing", () => {
    let state: CaptureState = { kind: "keypad", digits: "", attempt: 0 };
    state = speak(state, "I don't have my phone away from my ear").state;
    const gone = speak(state, "Can you just take it down?");
    expect(gone.state.kind).toBe("escalate");
    expect(gone.say).toContain("colleague");
  });

  it("terminates even when the caller never answers the question", () => {
    // Neither agreement nor a number, repeatedly: this must still reach the keypad
    // rather than asking forever.
    let state = speak(idle, "four one seven").state;
    for (let i = 0; i < 5; i += 1) state = speak(state, "What was that?").state;
    expect(["keypad", "escalate"]).toContain(state.kind);
  });

  it("is inert once the value is confirmed", () => {
    const asked = speak(idle, "four one seven");
    const done = speak(asked.state, "yes");
    const after = speak(done.state, "actually make it four one eight");
    expect(after.state).toEqual(done.state);
    expect(after.captured).toBeNull();
  });

  it("reads the value back through the normalizer, grouped for the ear", () => {
    const r = speak(idle, "oh eight one three eight one seven eight five five oh");
    // R4.3.2: the caller hears it the way they would say it, "oh" and all.
    expect(r.say).toContain("oh eight one three");
  });
});
