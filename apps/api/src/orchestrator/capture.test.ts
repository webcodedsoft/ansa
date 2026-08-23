import { describe, expect, it } from "vitest";

import {
  advance,
  confirmedUtterance,
  ENTITY_POLICY,
  expecting,
  idle,
  joinable,
  mustConfirm,
  spokenAttemptsFor,
  type CaptureState,
} from "./capture";

const speak = (state: CaptureState, text: string) => advance(state, { kind: "speech", text });
const press = (state: CaptureState, digit: string) => advance(state, { kind: "keypad", digit });

/**
 * Read off the call at 17:32 on 2026-08-23, the first with clean audio all day.
 *
 * The caller read their mobile number out five times, in fragments, because the turn
 * detector kept closing the turn mid-recitation. Each fragment parsed as digits and then
 * failed the eleven-digit check, and each time `beginCapture` returned to `awaiting` at
 * attempt 1 — so the counter never advanced, the keypad was never offered, and the agent
 * said "That doesn't look like a complete mobile number" in exactly the same words five
 * times running. It would have done that until they hung up.
 */
/**
 * A number the turn detector cut in half.
 *
 * Verbatim from the call at 17:32 on 2026-08-23, where the caller's own number arrived as
 * two turns because they paused between the digit groups — as everyone does. Read
 * separately both halves are the wrong length, both were rejected, and the caller was
 * asked again five times. Flux decides on silence and the pause is real, so this is the
 * capture engine's problem to solve rather than a threshold to tune.
 */
/**
 * Read off the call at 20:24 on 2026-08-23, where 99% of the audio arrived and the
 * conversation still failed:
 *
 *   caller  Hi. Good morning. Uh, my name is.        (cut off before the name)
 *   agent   Sorry — And your name?
 *   caller  You do?
 *   agent   You — have I got that right?
 *
 * The turn detector chopped them mid-sentence, and the parser took the confused fragment
 * that followed as what they were called.
 */
describe("what is never somebody's name", () => {
  it("does not take a pronoun from a caller who is asking a question back", () => {
    /* Asserted on the state, not on `captured`: nothing is captured until the caller has
       agreed the readback, so `captured` is null here whether or not the parser took it —
       which is how the first version of this test passed with the guard removed. */
    expect(speak(expecting("name").state, "You do?").state.kind).not.toBe("confirming");
  });

  it("does not take filler from a caller who was interrupted", () => {
    for (const said of ["Uh", "Erm...", "Um, wait"]) {
      const r = speak(expecting("name").state, said);
      expect(r.state.kind, said).not.toBe("confirming");
    }
  });

  it("still takes a real name in the same position", () => {
    /* The guard has to stay narrow. Excluding too much would send a caller with an
       ordinary name round the spelling loop, which is the failure it exists to prevent. */
    for (const said of ["Sikiru", "Adaeze", "Chukwuemeka", "Mary Grace"]) {
      const r = speak(expecting("name").state, said);
      expect(r.state.kind, said).toBe("confirming");
    }
  });
});

describe("digits split across two turns", () => {
  it("joins the halves into the number that was actually said", () => {
    const asked = expecting("phone").state;
    const first = speak(asked, "Zero eight one three eight one seven eight five");
    expect(first.captured).toBeNull();

    const second = speak(first.state, "five zero");
    expect(second.state.kind).toBe("confirming");
    expect(second.say).toContain("Is that right?");
  });

  it("takes a caller who starts over rather than gluing it to the last attempt", () => {
    /* They think you missed it, so they say the whole thing again. Joining that to what
       came before builds a twenty-digit number nobody said. */
    const asked = expecting("phone").state;
    const half = speak(asked, "zero eight one three eight one");
    const whole = speak(half.state, "zero eight one three eight one seven eight five five zero");

    expect(whole.state.kind).toBe("confirming");
  });

  it("joins runs of digits and nothing else", () => {
    /* Stated as the rule rather than probed through behaviour, because no prose parser
       returns a value for a fragment today — so the guard is unreachable by any input and
       a behavioural test of it would pass with the guard deleted. It is here for the day
       a partial address parses, which would otherwise glue two sentences into one. */
    for (const kind of ["phone", "reference", "nin", "bvn", "otp", "amount"] as const) {
      expect(joinable(kind), kind).toBe(true);
    }
    for (const kind of ["name", "email", "address", "date", "time"] as const) {
      expect(joinable(kind), kind).toBe(false);
    }
  });
});

describe("a number that keeps coming out the wrong length", () => {
  const short = "0813 817 85";

  it("stops repeating itself and offers the keypad", () => {
    let state: CaptureState = expecting("phone").state;

    const said: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const result = speak(state, short);
      state = result.state;
      if (result.say !== null) said.push(result.say);
    }

    // The objection is allowed a couple of goes, and then something else has to happen.
    const repeats = said.filter((line) => line.includes("complete mobile number")).length;
    expect(repeats).toBeLessThanOrEqual(2);
    expect(said.some((line) => line.toLowerCase().includes("keypad"))).toBe(true);
  });

  it("still objects the first time, because the caller may simply have misspoken", () => {
    const result = speak(expecting("phone").state, short);
    expect(result.say).toContain("complete mobile number");
  });
});

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
    const asked = speak(idle, "my policy number is four one seven");
    const done = speak(asked.state, "Yes, that's correct");
    expect(done.state.kind).toBe("confirmed");
    expect(done.captured).toBe("417");
  });

  it("accepts the Nigerian forms of agreement", () => {
    for (const yes of ["na so", "correct", "exactly", "yeah", "that's right"]) {
      const asked = speak(idle, "my policy number is four one seven");
      expect(speak(asked.state, yes).captured).toBe("417");
    }
  });

  it("takes a correction and a rejection said in one breath", () => {
    // "No, it's four one eight" is the normal way to correct a digit, and the correction
    // must not be lost to the rejection.
    const asked = speak(idle, "my policy number is four one seven");
    const fixed = speak(asked.state, "No, it's four one eight");
    expect(fixed.state).toMatchObject({ kind: "confirming", value: "418" });
    expect(fixed.say).toContain("four one eight");
    // A correction is speech too, so it gets read back rather than trusted.
    expect(fixed.captured).toBeNull();
  });

  it("never releases a value on a bare rejection", () => {
    const asked = speak(idle, "my policy number is four one seven");
    const rejected = speak(asked.state, "No");
    expect(rejected.captured).toBeNull();
    expect(rejected.state.kind).toBe("confirming");
  });

  it("offers the keypad after two failed spoken attempts, not sooner", () => {
    let state = speak(idle, "my policy number is four one seven").state;
    state = speak(state, "No").state;
    expect(state.kind).toBe("confirming"); // still speech on attempt two

    const third = speak(state, "No");
    expect(third.state.kind).toBe("keypad");
    expect(third.say).toContain("keypad");
  });

  it("accepts keypad digits and confirms on hash", () => {
    let state: CaptureState = { kind: "keypad", subject: "reference", digits: "", attempt: 0 };
    for (const d of "417") state = press(state, d).state;
    const done = press(state, "#");
    // Tones are unambiguous, so there is nothing a readback could catch.
    expect(done.captured).toBe("417");
  });

  it("lets star clear a mistyped entry", () => {
    let state: CaptureState = { kind: "keypad", subject: "reference", digits: "", attempt: 0 };
    for (const d of "419") state = press(state, d).state;
    state = press(state, "*").state;
    for (const d of "417") state = press(state, d).state;
    expect(press(state, "#").captured).toBe("417");
  });

  it("escalates rather than looping when the keypad is not working either", () => {
    const empty: CaptureState = { kind: "keypad", subject: "reference", digits: "", attempt: 0 };
    expect(press(empty, "#").state.kind).toBe("escalate");
  });

  it("escalates when the caller keeps talking instead of typing", () => {
    let state: CaptureState = { kind: "keypad", subject: "reference", digits: "", attempt: 0 };
    state = speak(state, "I don't have my phone away from my ear").state;
    const gone = speak(state, "Can you just take it down?");
    expect(gone.state.kind).toBe("escalate");
    expect(gone.say).toContain("colleague");
  });

  it("terminates even when the caller never answers the question", () => {
    // Neither agreement nor a number, repeatedly: this must still reach the keypad
    // rather than asking forever.
    let state = speak(idle, "my policy number is four one seven").state;
    for (let i = 0; i < 5; i += 1) state = speak(state, "What was that?").state;
    expect(["keypad", "escalate"]).toContain(state.kind);
  });

  it("is inert once the value is confirmed", () => {
    const asked = speak(idle, "my policy number is four one seven");
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
    expect(r.state).toMatchObject({ subject: "reference" });
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

/**
 * Fixed clock: Friday 2026-08-07, 09:00 in Lagos. Passed explicitly so no test here
 * depends on when it runs.
 */
const NOW = Date.parse("2026-08-07T08:00:00Z");

const say = (state: CaptureState, text: string, confidence?: number | null) =>
  advance(state, { kind: "speech", text, at: NOW, confidence });

const agree = (state: CaptureState) => say(state, "Yes, that is correct");

describe("escalation is terminal for capture, not for the call", () => {
  it("lets the model answer the turn after an escalation", () => {
    // 2026-08-08, 12:12:42. Once capture reached `escalate` it kept reporting every
    // later turn as handled with nothing to say, so the agent went silent for the rest
    // of the call — having just told the caller a colleague was coming.
    let state = say(idle, "My name is Hill").state;
    state = say(state, "No").state;
    state = say(state, "I already told you").state;
    state = say(state, "This is ridiculous").state;
    expect(state.kind).toBe("escalate");

    const after = say(state, "Actually, can you tell me my renewal date?");
    expect(after.handled).toBe(false);
    expect(after.state.kind).toBe("escalate");
  });

  it("does not drag an escalated caller back into a readback", () => {
    // They failed three times. Offering to confirm a policy number now is the loop they
    // were just rescued from.
    const escalated: CaptureState = { kind: "escalate" };
    const after = say(escalated, "my policy number is four one seven two nine");
    expect(after.state.kind).toBe("escalate");
    expect(after.say).toBeNull();
    expect(after.handled).toBe(false);
  });

  it("releases a turn that holds nothing worth capturing", () => {
    // The same class of bug one state earlier: capture ran, found nothing, and the
    // orchestrator still counted the turn as handled.
    const r = say(idle, "I want to renew my cover");
    expect(r.handled).toBe(false);
    expect(r.say).toBeNull();
  });

  it("claims the turn while it is actually confirming something", () => {
    const r = say(idle, "my policy number is four one seven two nine");
    expect(r.handled).toBe(true);
    // And on the turn the value is released, which has nothing to say but is very much
    // capture's turn — the reason `handled` is not just `say !== null`.
    const done = agree(r.state);
    expect(done.say).toBeNull();
    expect(done.handled).toBe(true);
    expect(done.captured).toBe("41729");
  });
});

describe("risk decides whether a value is confirmed at all (§9)", () => {
  it("confirms every identifier, with no way to opt out", () => {
    for (const kind of ["name", "reference", "phone", "email", "nin", "bvn", "otp"] as const) {
      expect(ENTITY_POLICY[kind].risk, kind).toBe("identifier");
      expect(ENTITY_POLICY[kind].confirm, kind).toBe("always");
      // R4.3.1: no confidence, however high, reaches a false.
      expect(mustConfirm(kind, "whatever", 1), kind).toBe(true);
      expect(mustConfirm(kind, "whatever", 0.99), kind).toBe(true);
    }
  });

  it("confirms consequential values too, because a wrong action is a wrong action", () => {
    for (const kind of ["address", "date", "time", "amount"] as const) {
      expect(ENTITY_POLICY[kind].risk, kind).toBe("consequential");
      expect(mustConfirm(kind, "2026-08-14", 1), kind).toBe(true);
    }
  });

  it("leaves a conversational quantity alone", () => {
    // "You have three policies, let me read that back, three, is that correct?"
    const r = say(idle, "I have three policies");
    expect(r.state).toEqual(idle);
    expect(r.say).toBeNull();
  });

  it("no longer reads a year back at the caller", () => {
    // The old shape rule confirmed this because it was four characters long.
    const r = say(idle, "I have been with you since 2019");
    expect(r.state.kind).toBe("idle");
  });

  it("confirms a quantity after all when the transcriber says it struggled", () => {
    // The only direction confidence is allowed to move the decision.
    const r = say(idle, "I have three policies", 0.4);
    expect(r.state.kind).toBe("confirming");
    expect(r.state).toMatchObject({ subject: "quantity" });
  });

  it("has no confirmation rule that means never", () => {
    // A `"never"` in this union is the change that quietly repeals R4.3.1.
    const rules = Object.values(ENTITY_POLICY).map((p) => p.confirm);
    expect(rules).not.toContain("never");
  });
});

describe("confidence may add checking and never remove it", () => {
  it("shortens the road to the keypad on a bad line", () => {
    expect(spokenAttemptsFor("reference", 0.4)).toBeLessThan(spokenAttemptsFor("reference", 0.95));
    expect(spokenAttemptsFor("reference", 0.4)).toBeGreaterThanOrEqual(1);
  });

  it("does not shorten it when there is nowhere better to go", () => {
    // A date cannot be typed or spelled, so cutting attempts short only escalates
    // sooner — which is not more checking, it is less conversation.
    expect(spokenAttemptsFor("date", 0.4)).toBe(spokenAttemptsFor("date", 0.95));
  });

  it("still reads the value back on a bad line", () => {
    const r = say(idle, "my policy number is four one seven two nine", 0.2);
    expect(r.state.kind).toBe("confirming");
    // Grouped in threes for the ear, so the digits are there with a pause in them.
    expect(r.say).toContain("four one seven");
  });

  it("treats an absent confidence as neither high nor low", () => {
    expect(spokenAttemptsFor("reference", null)).toBe(spokenAttemptsFor("reference", 0.95));
    expect(mustConfirm("quantity", "3", null)).toBe(false);
  });
});

describe("phone numbers", () => {
  it("captures and canonicalises one the caller gave", () => {
    const r = say(idle, "my mobile is oh eight one three eight one seven eight five five oh");
    expect(r.state).toMatchObject({ subject: "phone", value: "08138178550" });
    expect(r.say).toContain("oh eight one three");
    expect(agree(r.state).captured).toBe("08138178550");
  });

  it("takes the international form as the same number", () => {
    const r = say(idle, "call me on two three four eight one three eight one seven eight five five oh");
    expect(r.state).toMatchObject({ subject: "phone", value: "08138178550" });
  });

  it("asks again rather than confirming half a number", () => {
    // "Is that right?" on nine digits wastes an exchange on something already wrong.
    const r = say(idle, "my phone number is eight one three eight one seven");
    expect(r.state.kind).toBe("awaiting");
    expect(r.say).toContain("complete mobile number");
  });
});

describe("email", () => {
  it("captures a spelled address and spells the local part back", () => {
    const r = say(idle, "my email is s i k i r u at gmail dot com");
    expect(r.state).toMatchObject({ subject: "email", value: "sikiru@gmail.com" });
    expect(r.say).toContain("S, I, K, I, R, U");
    expect(agree(r.state).captured).toBe("sikiru@gmail.com");
  });

  it("falls back to spelling just the local part, keeping the domain", () => {
    const asked = say(idle, "my email is sequium at gmail dot com");
    const no = say(asked.state, "No, that's not it");
    expect(no.state.kind).toBe("spelling");
    expect(no.say).toContain("the part before the at");

    const spelled = say(no.state, "S I K I R U");
    expect(spelled.state).toMatchObject({ value: "sikiru@gmail.com" });
  });
});

describe("dates and times", () => {
  it("reads a date back with the weekday, which the caller never gave", () => {
    const r = say(idle, "can you call me back on the fourteenth of August");
    expect(r.state).toMatchObject({ subject: "date", value: "2026-08-14" });
    // NOW is a Friday and so is the 14th; a caller who meant Tuesday hears it here.
    expect(r.say).toContain("Friday the fourteenth of August");
    expect(agree(r.state).captured).toBe("2026-08-14");
  });

  it("says which way it guessed the am or pm", () => {
    const r = say(idle, "half past two");
    expect(r.state).toMatchObject({ subject: "time", value: "14:30" });
    expect(r.say).toContain("in the afternoon");
  });

  it("escalates rather than offering a keypad for a date", () => {
    // There is no key for "next Tuesday".
    let state = say(idle, "call me back tomorrow").state;
    state = say(state, "No").state;
    state = say(state, "No").state;
    expect(state.kind).toBe("escalate");
  });
});

describe("amounts", () => {
  it("captures the amount and not the other number in the turn", () => {
    const r = say(idle, "I have three policies and the premium is forty five thousand naira");
    expect(r.state).toMatchObject({ subject: "amount", value: "45000" });
    // Said as words: "forty-five thousand naira" is checkable by ear, digits are not.
    expect(r.say).toContain("forty-five thousand naira");
  });
});

describe("addresses", () => {
  it("keeps the caller's own words and reads them back", () => {
    const r = say(idle, "my address is 14 Adeola Odeku Street, Victoria Island");
    expect(r.state).toMatchObject({ subject: "address" });
    expect(r.say).toContain("Adeola Odeku Street");
    expect(agree(r.state).captured).toBe("14 Adeola Odeku Street, Victoria Island");
  });
});

describe("the identifiers with a knowable shape", () => {
  it("catches a short NIN before asking the caller to confirm it", () => {
    const r = say(idle, "my NIN is one two three four five six seven eight nine");
    expect(r.state.kind).toBe("awaiting");
    expect(r.say).toContain("nine digits");
    expect(r.say).toContain("eleven");
  });

  it("confirms a full BVN", () => {
    const r = say(idle, "my BVN is two two one one three three four four five five six");
    expect(r.state).toMatchObject({ subject: "bvn", value: "22113344556" });
    expect(agree(r.state).captured).toBe("22113344556");
  });

  it("applies the shape check to keypad entry too", () => {
    // Tones are unambiguous, but a caller can type nine digits perfectly clearly.
    let state: CaptureState = { kind: "keypad", subject: "nin", digits: "", attempt: 0 };
    for (const d of "123456789") state = press(state, d).state;
    const short = press(state, "#");
    expect(short.captured).toBeNull();
    expect(short.say).toContain("nine digits");
  });

  it("treats a NIN as an ordinary value, because nothing is masked any more", () => {
    /* `logSafe` masked a NIN, a BVN and a one-time code on the way to the event log. It
       was removed on 2026-08-15 with R5.2.4: no caller value is redacted anywhere, and the
       organisation is the data controller for its own call records.

       The consequence is deliberate and worth stating where somebody will read it — the
       event log now holds national identity numbers and one-time codes in the clear, and
       is identifying data at rest. Nothing in the capture engine decides otherwise. */
    const policy = ENTITY_POLICY.nin;
    expect(policy.risk).toBe("identifier");
    expect("sensitive" in policy).toBe(false);
  });
});

describe("the agent asking first", () => {
  it("asks, then parses the answer as the kind it asked for", () => {
    // "Sikiru" and "the fourteenth" are not recognisable as values in free speech. They
    // are unambiguous in answer to a question, which is what `awaiting` is for.
    const asked = expecting("name");
    expect(asked.say).toContain("your name");

    const answered = say(asked.state, "Sikiru");
    expect(answered.state).toMatchObject({ subject: "name", value: "Sikiru" });
  });

  it("takes a bare date once it has been asked for", () => {
    const answered = say(expecting("date").state, "the fourteenth");
    expect(answered.state).toMatchObject({ subject: "date", value: "2026-08-14" });
  });

  it("takes a bare amount once it has been asked for, and not before", () => {
    expect(say(idle, "about forty five thousand").state.kind).toBe("idle");
    const answered = say(expecting("amount").state, "about forty five thousand");
    expect(answered.state).toMatchObject({ subject: "amount", value: "45000" });
  });

  it("gives up on a caller who will not answer the question", () => {
    let state = expecting("email").state;
    state = say(state, "Sorry, what?").state;
    state = say(state, "I can't hear you").state;
    expect(["spelling", "escalate"]).toContain(state.kind);
  });
});

describe("every entity has a capture mode, a normalizer path and a rule", () => {
  it("is complete, so adding a kind means filling in a row", () => {
    for (const [kind, policy] of Object.entries(ENTITY_POLICY)) {
      expect(policy.ask.length, kind).toBeGreaterThan(0);
      expect(policy.label.length, kind).toBeGreaterThan(0);
      expect(["spelling", "keypad", "retry"], kind).toContain(policy.fallback);
      expect(["identifier", "consequential", "conversational"], kind).toContain(policy.risk);
      // The normalizer path: every kind can say its own value back (R4.3.2).
      expect(typeof policy.say, kind).toBe("function");
    }
  });

  it("only lets the conversational tier skip confirmation", () => {
    for (const [kind, policy] of Object.entries(ENTITY_POLICY)) {
      if (policy.confirm === "when-uncertain") {
        expect(policy.risk, kind).toBe("conversational");
      }
    }
  });
});

/**
 * Nothing in capture or the normalizer may key on a value.
 *
 * These tables exist so that a change which only helps one name fails visibly. They are
 * deliberately unrelated to the values in the live-call regressions above: those record
 * what went wrong once, these prove the logic is about shape and context rather than
 * about any particular string. None of them is a name anyone on this project has said.
 */
const NAMES: readonly { readonly label: string; readonly name: string }[] = [
  { label: "short, East Asian", name: "Ng" },
  { label: "short, Anglo diminutive", name: "Bea" },
  { label: "common Anglo", name: "Harriet" },
  { label: "West African, Akan", name: "Kwabena" },
  { label: "East African, Kikuyu", name: "Wanjiru" },
  { label: "long South Asian", name: "Venkataraman" },
  { label: "Arabic with particle", name: "Al Rashid" },
  { label: "Slavic", name: "Nowakowski" },
  { label: "Iberian, two-part", name: "Pilar Escamilla" },
  { label: "Dutch, particled three-part", name: "Anke van Dijk" },
  { label: "unusual pronunciation", name: "Siobhan" },
  { label: "hyphenated", name: "Marie Claude" },
];

const spellingOf = (name: string): string =>
  name
    .split(" ")
    .map((part) => [...part].join(" "))
    .join(" space ");

describe("names: the logic is about shape, not about any name", () => {
  for (const { label, name } of NAMES) {
    it(`captures and confirms a ${label} name`, () => {
      const asked = say(idle, `My name is ${name}`);
      expect(asked.state, name).toMatchObject({ subject: "name", value: name });
      expect(asked.say, name).toContain(name);
      expect(agree(asked.state).captured, name).toBe(name);
    });

    it(`recovers a ${label} name through spelling`, () => {
      // The transcriber got something else; the caller spells it. This is the path that
      // has to work for a name nobody has ever boosted a keyterm for.
      let state = say(idle, "My name is Something Else").state;
      state = say(state, "No, that's not it").state;
      expect(state.kind, name).toBe("spelling");

      const spelled = say(state, spellingOf(name));
      // Case-insensitive on purpose. A spelling carries letters and word boundaries and
      // nothing else — a caller does not pronounce the lowercase "v" in a particled
      // name, so title case per part is the honest reconstruction. Case is a storage
      // concern, not a readback one: the caller hears the same sounds either way.
      expect(spelled.state, name).toMatchObject({
        value: expect.stringMatching(new RegExp(`^${name}$`, "i")),
      });
      expect(agree(spelled.state).captured?.toLowerCase(), name).toBe(name.toLowerCase());
    });
  }

  it("keeps a spelling alphabet structural rather than enumerated", () => {
    // "X for Word" works because Word begins with X, not because Word is in a table.
    // The illustrating words here are ordinary nouns from no spelling alphabet at all.
    const state = say(say(idle, "My name is Something Else").state, "No").state;
    const spelled = say(state, "B for bicycle, E for engine, A for anchor");
    expect(spelled.state).toMatchObject({ value: "Bea" });
  });

  it("does not read a name out of a turn that is a conversational move", () => {
    const state = say(say(idle, "My name is Something Else").state, "No").state;
    expect(say(state, "OK").state.kind).not.toBe("confirming");
  });

  it("keeps a name the transcriber emitted with its diacritics", () => {
    // An ASCII-only filter discarded the whole name, which is the failure this module
    // exists to prevent.
    expect(say(idle, "My name is Ayòbámi").state).toMatchObject({ value: "Ayòbámi" });
  });

  it("does not read a callback instruction as an introduction", () => {
    // "call me" is both an introduction and the front of "call me on oh eight one…".
    const r = say(idle, "call me on oh eight one three eight one seven eight five five oh");
    expect(r.state).toMatchObject({ subject: "phone" });
  });
});

/**
 * Identifier shapes, again unrelated to anything a live call produced. Every one is
 * synthetic and none of them is special-cased anywhere.
 */
const IDENTIFIERS: readonly {
  readonly label: string;
  readonly spoken: string;
  readonly value: string;
}[] = [
  { label: "purely numeric, digit by digit", spoken: "six two nine four one", value: "62941" },
  { label: "numeric with a leading zero", spoken: "oh four four seven one", value: "04471" },
  { label: "leading letters", spoken: "K R seven three nine two", value: "KR7392" },
  { label: "trailing letters", spoken: "five five one eight T Q", value: "5518TQ" },
  { label: "interleaved letters and digits", spoken: "J four M nine P two", value: "J4M9P2" },
  { label: "spoken as tens rather than digits", spoken: "sixty two ninety four", value: "6294" },
  { label: "spoken with a repeat", spoken: "double seven three one five", value: "77315" },
  { label: "spoken with a pause mid-value", spoken: "eight three one, um, six four", value: "83164" },
  { label: "letter O next to letters", spoken: "R O V four two eight", value: "ROV428" },
];

describe("identifiers: the logic is about shape, not about any identifier", () => {
  for (const { label, spoken, value } of IDENTIFIERS) {
    it(`captures a reference given with ${label}`, () => {
      const asked = say(idle, `My policy number is ${spoken}`);
      expect(asked.state, label).toMatchObject({ subject: "reference", value });
      expect(asked.captured, label).toBeNull();
      expect(agree(asked.state).captured, label).toBe(value);
    });

    it(`accepts the same reference on the keypad where it is typeable`, () => {
      const digits = value.replace(/\D/g, "");
      let state: CaptureState = { kind: "keypad", subject: "reference", digits: "", attempt: 0 };
      for (const d of digits) state = press(state, d).state;
      expect(press(state, "#").captured, label).toBe(digits);
    });
  }

  it("takes a letter-only identifier once it has been asked for", () => {
    // A organization whose records are lettered has no digits to offer, and a run of letters
    // cannot be picked out of free speech. Directed, it is unambiguous.
    const answered = say(expecting("reference").state, "Q F R D M");
    expect(answered.state).toMatchObject({ subject: "reference", value: "QFRDM" });
  });

  it("survives a plausible transcription error and the correction that follows", () => {
    // The digit arrives wrong, the caller says so, the corrected value is read back
    // rather than trusted — and the wrong one is never offered again.
    const asked = say(idle, "My policy number is nine one four seven three");
    expect(asked.state).toMatchObject({ value: "91473" });

    const fixed = say(asked.state, "No, it's nine one four seven two");
    expect(fixed.state).toMatchObject({ value: "91472" });
    expect(fixed.captured).toBeNull();
    expect(fixed.say).not.toContain("seven three");
    expect(agree(fixed.state).captured).toBe("91472");
  });

  it("groups an identifier that fits no national pattern without mangling it", () => {
    // Nigerian mobile grouping is length-and-prefix specific; everything else falls back
    // to threes rather than being chopped into a shape it does not have.
    const r = say(idle, "my policy number is four four one six three two nine six oh one one one");
    expect(r.say).toContain("four four one");
    expect(r.state).toMatchObject({ value: "441632960111" });
  });
});

describe("what the model is told once a value is confirmed", () => {
  it("says what kind of thing it is, rather than sniffing the shape", () => {
    // The orchestrator used to regex the value to guess name-or-number, so a confirmed
    // date reached the model as "My number is 2026-08-14."
    expect(confirmedUtterance("date", "2026-08-14")).toContain("The date is 2026-08-14");
    expect(confirmedUtterance("email", "ada@example.com")).toContain("My email is");
    expect(confirmedUtterance("name", "Kwabena")).toContain("My name is Kwabena");
    expect(confirmedUtterance("bvn", "22113344556")).toContain("My B V N is");
  });

  it("is phrased as the caller's own words, because it enters history as a caller turn", () => {
    // A system note here is a system note the model may read aloud.
    for (const kind of Object.keys(ENTITY_POLICY) as (keyof typeof ENTITY_POLICY)[]) {
      expect(confirmedUtterance(kind, "x"), kind).toMatch(/^Yes, that is/);
    }
  });
});
