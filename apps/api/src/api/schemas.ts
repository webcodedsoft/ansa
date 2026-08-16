import { MEMBER_ROLES, type MemberRole } from "@ansa/db";

import { choice, flag, integer, list, object, text, type Schema } from "./http/schema";

/**
 * The field shapes more than one endpoint needs.
 *
 * Kept small on purpose. A schema used by exactly one endpoint belongs in that endpoint's
 * file, next to the handler it describes — the point of this layer is that the shape and
 * the code are read together.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Permissive by design. Anything stricter rejects addresses that exist — the only
 * authority on whether an address is real is whether mail to it arrives, and an
 * invitation is exactly that test.
 */
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * E.164, as migration 0015's CHECK constraint spells it and as `handoff/destination.ts`
 * spells it for the environment fallback. Those two are a SQL constraint and a
 * module-private constant, so this is a third copy rather than a shared one; what it buys is
 * that a malformed number is a 422 with the field named instead of a 500 from the database.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

export const uuid = (): Schema<string> => text({ format: "uuid", pattern: UUID });

/** A number in E.164, which is the only form anything downstream of the API accepts. */
export const phoneNumber = (): Schema<string> => text({ maxLength: 16, pattern: E164 });

export const email = (): Schema<string> => text({ format: "email", maxLength: 320, pattern: EMAIL });

export const timestamp = (): Schema<string> => text({ format: "date-time" });

export const role = (): Schema<MemberRole> => choice(MEMBER_ROLES);

/** An organisation, as the dashboard shows it. It is a `organizations` row; see migration 0016. */
export const organisation = object({ id: uuid(), name: text({ maxLength: 200 }) });

/** The most fields one agent's form may hold. A voice call cannot conduct more. */
export const MAX_CAPTURED_FIELDS = 40;

/**
 * One thing the agent asks a caller for.
 *
 * A voice form, so every field carries how it is *asked* and how it is *confirmed* — the
 * two questions a web form never has to answer. `confirm` is the one that matters: a
 * write-tier tool will not fire on an unconfirmed value however confident the transcriber
 * was, because 8 kHz audio does not support that confidence.
 */
export const capturedField = object({
  /** How tools receive it. An identifier, not a label — `policyNumber`, not "Policy number". */
  key: text({ maxLength: 64, pattern: /^[a-zA-Z][a-zA-Z0-9_]*$/ }),
  /**
   * The engine's own vocabulary, not a parallel one.
   *
   * `capture.ts` knows how to hear, check and read back twelve kinds of value — including
   * a NIN's eleven digits and an email's spelling fallback. A shorter list here would mean
   * translating configuration into it and losing the difference between an eleven-digit
   * BVN and "a number", which is exactly the check that catches a dropped digit.
   *
   * `choice` and `text` are the two the engine does not capture: nothing is read back and
   * the answer stays in the transcript for the model to read.
   */
  type: choice(["name", "reference", "phone", "email", "address", "date", "time", "amount", "nin", "bvn", "otp", "quantity", "choice", "text"]),
  /** Written as speech, not as a form label. It goes through the normalizer before it is spoken. */
  prompt: text({ maxLength: 300 }),
  /**
   * Keypad tones survive an 8 kHz line intact. For anything with a checkable structure,
   * prefer it — it is the difference between a guess and a fact.
   */
  capture: choice(["speech", "keypad", "either"]),
  /**
   * Whether the agent checks the value back before anything uses it.
   *
   * The operator's choice, including "none", and that is a product decision rather than an
   * oversight. The capture engine's own risk table would always read an identifier back;
   * this overrides it, so a field marked `none` is taken as heard.
   *
   * It does not override the dispatch path. A write-tier tool naming this field in its
   * `identifiers` still refuses to fire on a value nothing confirmed — that gate is about
   * what may be acted on, not about what may be asked, and no configuration reaches it.
   */
  confirm: choice(["none", "readback", "spellback"]),
  /** Rejected values are re-asked, not passed on. Empty means anything is accepted. */
  pattern: text({ maxLength: 200 }),
  /** Then it transfers to a person, rather than asking a fourth time. */
  attempts: integer({ minimum: 1, maximum: 10 }),
  required: flag(),
  /** Only meaningful for `choice`. Empty otherwise. */
  options: list(text({ maxLength: 120 }), { maxItems: 24 }),
});
