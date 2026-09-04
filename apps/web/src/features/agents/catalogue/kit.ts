import type { CapturedField } from "../agents.schema";
import { field, type AgentTemplate, type TemplateArm, type TemplatePolicy } from "../templates.shape";

/**
 * What every sector's templates are built from.
 *
 * The constructors carry the capture decisions once — a phone number is taken by keypad or
 * speech and read back; a reference is read back; an email is spelled back and never
 * required, because spelling an address down an 8 kHz line is the worst minute of any call
 * — so a template only names what it asks and in what order. The rules carry the sentences
 * every Nigerian business needs said and few would think to write.
 */

/* ------------------------------------------------------------- the questions */

export const name = (prompt = "And who am I speaking with, please?"): CapturedField =>
  field("callerName", "name", prompt, { confirm: "readback" });

export const phone = (key = "callbackNumber", prompt = "What's the best number to reach you on?"): CapturedField =>
  field(key, "phone", prompt, { capture: "either", confirm: "readback" });

export const ref = (key: string, prompt: string, pattern = ""): CapturedField =>
  field(key, "reference", prompt, { capture: "either", confirm: "readback", pattern });

export const choice = (key: string, prompt: string, options: readonly string[]): CapturedField =>
  field(key, "choice", prompt, { options: [...options] });

export const text = (key: string, prompt: string, required = true): CapturedField =>
  field(key, "text", prompt, { attempts: 2, required });

export const date = (key: string, prompt: string): CapturedField =>
  field(key, "date", prompt, { confirm: "readback" });

export const time = (key: string, prompt: string): CapturedField =>
  field(key, "time", prompt, { confirm: "readback" });

export const amount = (key: string, prompt: string): CapturedField =>
  field(key, "amount", prompt, { confirm: "readback" });

export const address = (key: string, prompt: string): CapturedField =>
  field(key, "address", prompt, { confirm: "readback" });

export const email = (key: string, prompt: string): CapturedField =>
  field(key, "email", prompt, { confirm: "spellback", required: false });

export const quantity = (key: string, prompt: string): CapturedField =>
  field(key, "quantity", prompt, { confirm: "readback" });

/* ------------------------------------------------------------------ the arms */

/** A service that ends with what happens next. */
export const service = (fields: readonly CapturedField[], closing: string): TemplateArm => ({ fields, closing });

/** A service that ends with a person, after a word about why. */
export const handover = (fields: readonly CapturedField[], why: string): TemplateArm => ({ fields, handover: why });

/**
 * A service that forks again, on a question asked at the end of its own.
 *
 * The choice is built from the arms' keys, so the options a caller may pick and the arms
 * that catch them cannot drift apart — the one way a fork ships with a dead end.
 */
export const forked = (
  fields: readonly CapturedField[],
  key: string,
  prompt: string,
  arms: Readonly<Record<string, TemplateArm>>,
): TemplateArm => ({
  fields: [...fields, choice(key, prompt, Object.keys(arms))],
  branch: { on: key, arms },
});

/**
 * The front desk: the question that sorts the call, and the services it sorts into.
 *
 * Spread into a template as `...desk(...)`. The reason is asked first — that is what the
 * greeting invites — and the name and number follow it, so a caller who rang about one
 * thing is not interviewed before being heard.
 */
export const desk = (
  arms: Readonly<Record<string, TemplateArm>>,
  prompt = "What are you calling about today?",
  opening: readonly CapturedField[] = [name(), phone()],
): Pick<AgentTemplate, "fields" | "branch"> => ({
  fields: [choice("reason", prompt, Object.keys(arms)), ...opening],
  branch: { on: "reason", arms },
});

/**
 * The catch-all every front desk needs: what they rang about is not one of the listed
 * services, so take it in their words and either promise a call back or put them through.
 */
export const anythingElse = (key = "otherMatter", who = "somebody who can help"): TemplateArm =>
  service(
    [text(key, "Tell me what it's about, and I'll make sure it reaches the right person.")],
    `Tell them ${who} will call them back on the number they gave, and thank them for calling.`,
  );

export const complaint = (key = "complaintDetail"): TemplateArm =>
  handover(
    [text(key, "I'm sorry to hear that. Tell me what happened, in your own words.")],
    "Apologise once, sincerely, say you are putting them through to somebody who can put it right, and pass on what they told you.",
  );

/* ----------------------------------------------------------------- the rules */

/** The sentences every inbound agent gets, before its own. */
const ALWAYS = [
  "Answer in two sentences at most.",
  "Read every number and name back before you use it, and take a correction without arguing.",
  "Amounts are in naira and times are West Africa Time.",
  "Sir and ma are respectful here; use them once, not every sentence. If they speak Pidgin, understand it and answer in plain English.",
  "If you cannot check something, say so in a few words and offer to put them through to a person.",
];

export const rules = (...own: readonly string[]): string => [...ALWAYS, ...own].join(" ");

/** The sentences every outbound agent gets: the ones the outbound layer also enforces. */
const OUTBOUND = [
  "You placed this call. Say who you are, which company, and why you are calling, before anything else, then ask whether now is a good time.",
  "If it is not a good time, offer to call back and end the call. Do not try to do the thing you rang about.",
  "Never ask for a date of birth, an address, an ID number, a card, an account or a PIN.",
  "If they say they are not the person you asked for, apologise, do not say why you called, and end the call.",
];

export const outboundRules = (...own: readonly string[]): string => [...OUTBOUND, ...own].join(" ");

/* -------------------------------------------------------------- the policies */

export const policy = (
  name: string,
  applies: string,
  can: readonly string[],
  cannot: readonly string[],
  escalate: readonly string[] = [],
): TemplatePolicy => ({ name, applies, canDo: can, cannotDo: cannot, escalateWhen: escalate });

/** The policy every business with a counter needs and none writes down. */
export const EMERGENCY = policy(
  "Emergencies",
  "They say it is an emergency, somebody is hurt, there is a fire, a flood, or a gas smell.",
  ["Tell them to call 112 if anyone is in danger.", "Put them through to a person immediately."],
  ["Take a message instead of transferring.", "Ask the routine questions first."],
  ["The word emergency, or anything that sounds like one."],
);

export const NO_PROMISES = policy(
  "Promises",
  "They ask you to confirm a price, a date, availability, or that something will definitely happen.",
  ["Say what the usual case is, if you know it.", "Take their details so a person can confirm."],
  ["Confirm a price, a date or availability from memory.", "Say definitely, guaranteed, or promise."],
);

export const SOMEBODY_ELSE = policy(
  "Somebody else's details",
  "They ask about an account, booking, order, result or record that is not their own.",
  ["Take a message for the person named.", "Explain that you can only discuss a record with the person it belongs to."],
  ["Read out, confirm or deny anything about another person's record."],
);

export const AGENT_MEMORY = policy(
  "What you know",
  "They ask something you would need a record to answer — a balance, a status, a result, a booking.",
  ["Say plainly that you cannot see records on this call.", "Take the details a person needs to answer it."],
  ["Guess, estimate, or make up a status, a balance or a result."],
);

/* --------------------------------------------------------------- the wrapper */

type Draft = Omit<AgentTemplate, "bargeIn" | "answeringMachineDetection">;

/* Keyterms are deduplicated here rather than by hand: every list starts from a shared one
   and adds its own, and a word in both is a word the business says a lot, not a mistake. */
const unique = (template: Draft): Draft => ({ ...template, keyterms: [...new Set(template.keyterms)] });

export const inbound = (template: Draft): AgentTemplate => ({ ...unique(template), bargeIn: true, answeringMachineDetection: false });

export const outbound = (template: Draft): AgentTemplate => ({ ...unique(template), bargeIn: true, answeringMachineDetection: true });

/** Places most Nigerian callers name, and the way they name them. Every list starts from these. */
export const NIGERIA = [
  "Lagos", "Abuja", "Port Harcourt", "Ibadan", "Kano", "Enugu", "Lekki", "Ikeja", "Victoria Island", "Ajah",
  "Yaba", "Surulere", "Ikoyi", "Gwarinpa", "Wuse", "Garki", "Maitama", "Asokoro", "GRA", "Sangotedo",
  "naira", "kobo", "estate", "junction", "roundabout", "expressway",
];
