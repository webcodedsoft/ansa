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
    expect(r.say).toContain("Is that right?");
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

describe("readback regressions from live calls", () => {
  it("does not confirm a value the caller is rejecting", () => {
    // 2026-08-08, 10:34:55. "No. No. That's not correct." confirmed the number, because
    // "correct" matched agreement and cancelled the rejection guard. The worst possible
    // outcome for this state machine.
    const asked = speak(idle, "eight four nine two six two five six");
    const rejected = speak(asked.state, "No. No. That's not correct.");

    expect(rejected.captured).toBeNull();
    expect(rejected.state.kind).not.toBe("confirmed");
  });

  it("treats every phrasing of 'that is not right' as a rejection", () => {
    for (const said of [
      "No, that's not correct",
      "that is not right",
      "no that's wrong",
      "nope, incorrect",
      "no, that's a mistake",
    ]) {
      const asked = speak(idle, "four one seven two nine");
      expect(speak(asked.state, said).captured, said).toBeNull();
    }
  });

  it("still hears agreement that happens to contain 'no'", () => {
    // Nigerian English uses all three, and none of them is a rejection.
    for (const said of ["Yes, no problem", "Correct, no worries", "Yes now, no wahala"]) {
      const asked = speak(idle, "four one seven two nine");
      expect(speak(asked.state, said).captured, said).toBe("41729");
    }
  });

  it("does not take a bare discourse marker as confirmation", () => {
    // "Right? What'd be good?" opened a caller turn on the same call.
    const asked = speak(idle, "four one seven two nine");
    expect(speak(asked.state, "Right?").captured).toBeNull();
  });
});

describe("names (2026-08-08 call: Sikiru -> Hill -> Sequium -> Security)", () => {
  it("confirms a name the caller introduces, as a word not a spelling", () => {
    const r = speak(idle, "Hi. Good morning. My name is Hill. How are you doing?");
    expect(r.state).toMatchObject({ kind: "confirming", subject: "name", value: "Hill" });
    // Spelling it back before they have complained is slower and faintly insulting.
    expect(r.say).toContain("Hill");
    expect(r.say).not.toContain("H I");
    expect(r.captured).toBeNull();
  });

  it("does not swallow the rest of the turn into the name", () => {
    const r = speak(idle, "My name is Hill. How are you doing?");
    expect(r.state).toMatchObject({ value: "Hill" });
  });

  it("goes straight to spelling when a name is rejected", () => {
    // Asking someone to say it again slowly is what produced three wrong spellings.
    const asked = speak(idle, "My name is Hill");
    const no = speak(asked.state, "No, that's not it");
    expect(no.state.kind).toBe("spelling");
    expect(no.say).toContain("spell");
  });

  it("takes the spelled name and confirms that instead", () => {
    let state = speak(idle, "My name is Security").state;
    state = speak(state, "No").state;
    const spelled = speak(state, "S I K I R U");
    expect(spelled.state).toMatchObject({ kind: "confirming", value: "Sikiru" });

    expect(speak(spelled.state, "Yes that's right").captured).toBe("Sikiru");
  });

  it("reads a spelling given with bridging words", () => {
    let state = speak(idle, "My name is Security").state;
    state = speak(state, "No").state;
    // The illustrating word is recognised by its own first letter, so this works for any
    // word in any language — no spelling alphabet is hardcoded.
    expect(speak(state, "S for Sunday, I for India, K, I, R, U").state).toMatchObject({
      value: "Sikiru",
    });
  });

  it("never re-parses a name from free speech", () => {
    // The transcriber already proved it cannot hear this name; parsing again produces a
    // third wrong version rather than a correction.
    const asked = speak(idle, "My name is Hill");
    const again = speak(asked.state, "No, it is Sequium");
    expect(again.state.kind).toBe("spelling");
  });

  it("hands over when spelling fails too", () => {
    let state = speak(idle, "My name is Hill").state;
    state = speak(state, "No").state;
    state = speak(state, "I already told you").state;
    expect(speak(state, "This is ridiculous").state.kind).toBe("escalate");
  });

  it("handles a two-part name, spelled", () => {
    let state = speak(idle, "My name is Security").state;
    state = speak(state, "No").state;
    // Nothing here knows about any particular name; it is letters in, letters out.
    expect(speak(state, "A D E D E J I").state).toMatchObject({ value: "Adedeji" });
  });

  it("still confirms a number the same way", () => {
    const r = speak(idle, "My policy number is four one seven two nine");
    expect(r.state).toMatchObject({ subject: "number" });
  });
});

describe("hedged answers are not agreement (2026-08-08, 11:07:32)", () => {
  it("does not confirm when the caller qualifies their yes", () => {
    // "Yeah. You tried. But what about the security?" confirmed a name the caller was
    // plainly querying, and the agent then used it to their face.
    const asked = speak(idle, "My name is Anita Security");
    const hedged = speak(asked.state, "Yeah. You tried. But what about the security?");
    expect(hedged.captured).toBeNull();
  });

  it("does not confirm when the answer contains a question", () => {
    const asked = speak(idle, "four one seven two nine");
    expect(speak(asked.state, "Yes, but can you check the last digit?").captured).toBeNull();
  });

  it("still accepts a clean yes", () => {
    const asked = speak(idle, "four one seven two nine");
    expect(speak(asked.state, "Yes, that is correct").captured).toBe("41729");
  });
});

describe("it has to sound like a person", () => {
  it("never asks the identical question twice in a row", () => {
    // 11:22:13 and 11:22:17 on a live call were the same sentence word for word.
    // Hearing that is how a caller learns they are talking to a machine.
    const first = speak(idle, "four one seven two nine");
    const second = speak(first.state, "What was that?");
    expect(second.say).not.toBe(first.say);
  });

  it("keeps a confirmation to something a person would actually say", () => {
    const r = speak(idle, "My name is Aditi");
    // "Let me make sure I have that right. Aditi. Have I got that?" was the old line.
    expect((r.say ?? "").split(/\s+/).length).toBeLessThanOrEqual(8);
    expect(r.say).toContain("Aditi");
  });

  it("does not explain how to spell until the caller has struggled once", () => {
    const state = speak(idle, "My name is Aditi").state;
    const asked = speak(state, "No");
    // The full instruction ran to seven and a half seconds of unbroken agent speech.
    expect(asked.say).toContain("spell");
    expect(asked.say).not.toContain("Abuja");

    const again = speak(asked.state, "I don't follow");
    expect(again.say).toContain("Abuja");
  });
});

describe("one STT result must not drive a decision (2026-08-08 call)", () => {
  it("never offers a value the caller has already rejected", () => {
    // The symptom: "TK — have I got that right?" / "No" / "Sorry — TK. Is that right?"
    // A rejected value is the one thing we know for certain is wrong.
    const asked = speak(idle, "My name is TK");
    const no = speak(asked.state, "No");
    expect(no.say ?? "").not.toContain("TK");
  });

  it("takes a fresh name offered instead of a rejection as the new candidate", () => {
    // The caller answered the readback with "My name is Kim Woo" — a correction the old
    // rule discarded, because it refused to re-read a name from free speech at all.
    const asked = speak(idle, "My name is TK");
    const corrected = speak(asked.state, "My name is Kim Woo");
    expect(corrected.say).toContain("Kim Woo");
    expect(corrected.captured).toBeNull();
  });

  it("prefers the candidate heard twice over the one heard once", () => {
    // Two independent results agreeing is much stronger evidence than one arriving
    // loudly. It still gets read back — agreement is not correctness.
    let state = speak(idle, "My name is Sikiru").state;
    state = speak(state, "My name is Shukri").state;
    const third = speak(state, "My name is Sikiru");
    expect(third.say).toContain("Sikiru");
    expect(third.captured).toBeNull();
  });

  it("does not resurrect a rejected value through repetition", () => {
    // Counting alone would let a mishearing win by frequency. Rejection outranks it.
    let state = speak(idle, "My name is TK").state;
    state = speak(state, "No").state;
    const again = speak(state, "TK");
    expect(again.say ?? "").not.toContain("TK");
  });

  it("hands over rather than asking a fourth time with nothing new", () => {
    let state = speak(idle, "four one seven two nine").state;
    state = speak(state, "No").state;
    state = speak(state, "No").state;
    expect(["keypad", "spelling", "escalate"]).toContain(state.kind);
  });

  it("carries rejections into spelling, so a spelling cannot repeat one", () => {
    let state = speak(idle, "My name is Sikir").state;
    state = speak(state, "No").state;
    expect(state.kind).toBe("spelling");
    // Spelling out the value already rejected is not a correction.
    const same = speak(state, "S I K I R");
    expect(same.say ?? "").not.toContain("Sikir —");
  });

  it("still confirms cleanly when the caller agrees first time", () => {
    const asked = speak(idle, "four one seven two nine");
    expect(speak(asked.state, "Yes, that is correct").captured).toBe("41729");
  });
});
