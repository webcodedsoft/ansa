import type { CapturedField } from "./agents.schema";

/**
 * One description of what each kind of captured value is and how it sounds.
 *
 * The field builder and the template preview both render an imagined exchange, and each
 * held a copy of this. They drifted immediately: one decided whether to spell a value out
 * by asking whether the string contained a space, the other by field type, so the same
 * template previewed two different calls depending which screen you were on. A preview
 * whose whole job is to show what the caller hears cannot have two opinions about it.
 *
 * The values are the capture engine's own kinds — `reference`, not "identifier" — because
 * a translation layer between what an operator picks and what the engine hears is one more
 * place for the two to disagree.
 */

/** Ordered by how often a Nigerian support line asks for them, not alphabetically. */
export const FIELD_TYPES: readonly {
  readonly value: CapturedField["type"];
  readonly label: string;
}[] = [
  { value: "name", label: "Name — spoken, spelled back if unclear" },
  { value: "reference", label: "Reference or policy number" },
  { value: "phone", label: "Phone number" },
  { value: "date", label: "Date" },
  { value: "time", label: "Time of day" },
  { value: "amount", label: "Amount of money" },
  { value: "quantity", label: "A count" },
  { value: "email", label: "Email address" },
  { value: "address", label: "Street address" },
  { value: "nin", label: "NIN — 11 digits, checked" },
  { value: "bvn", label: "BVN — 11 digits, checked" },
  { value: "otp", label: "One-time code" },
  { value: "choice", label: "One of a set — not read back" },
  { value: "text", label: "Free text — not read back" },
];

/**
 * A worked example per kind, so a preview reads like a call rather than a template.
 *
 * Invented rather than taken from anywhere: the point is the shape of the exchange, and a
 * placeholder that looked like real customer data would be worse, not better.
 */
export const SAMPLE: Readonly<Record<CapturedField["type"], string>> = {
  name: "Adaeze Okonkwo",
  reference: "PM8592625",
  phone: "+2348021184429",
  email: "adaeze@example.com",
  address: "14 Adeola Odeku Street, Victoria Island",
  date: "the fourth of March, nineteen eighty-eight",
  time: "half past two",
  amount: "forty-five thousand naira",
  nin: "12345678901",
  bvn: "22334455667",
  otp: "481920",
  quantity: "three",
  choice: "the first one",
  text: "a short answer",
};

/**
 * Kinds whose individual characters carry meaning, so a read-back spells them out.
 *
 * Decided by the kind, never by the string. Asking "does it contain a space" is right for
 * `PM8592625` and wrong for a one-word answer: a caller who said "Renew" was read back
 * "That's R e n e w — is that right?". One wrong digit in a reference is a different
 * customer; one wrong letter in a name is a name said slightly oddly.
 */
export const SPELLED: ReadonlySet<CapturedField["type"]> = new Set<CapturedField["type"]>([
  "reference",
  "phone",
  "nin",
  "bvn",
  "otp",
  "quantity",
]);

/**
 * Kinds where skipping the read-back is worth warning about.
 *
 * Not a restriction — the operator chooses and "none" is honoured. This only decides
 * whether the form explains the cost, which on an 8 kHz line is the difference between
 * fetching the right record and the wrong one. `choice` and `text` are absent because
 * nothing acts on them.
 */
export const RISKY_UNCONFIRMED: ReadonlySet<CapturedField["type"]> = new Set<
  CapturedField["type"]
>([
  "name",
  "reference",
  "phone",
  "email",
  "address",
  "date",
  "time",
  "amount",
  "nin",
  "bvn",
  "otp",
]);

/** Characters heard one at a time, shown one at a time. */
const spaced = (value: string): string => value.split("").join(" ");

/**
 * Whether this value is said character by character.
 *
 * Three ways in, and each is a real reason: the kind's characters carry meaning, the
 * operator asked for spell-back, or the caller keyed it in — digits typed one at a time
 * are read back the same way, because that is the form the caller has them in.
 */
const spellsOut = (field: CapturedField): boolean =>
  field.confirm === "spellback" || field.capture === "keypad" || SPELLED.has(field.type);

/**
 * The value the caller gives, decided once.
 *
 * Once, and that is the point rather than a tidy-up: the answer and the read-back have to
 * be the same value or the preview shows an agent repeating something the caller never
 * said. A choice field with options was answering "Renew" and hearing back "the first one".
 */
export const spokenValue = (field: CapturedField): string =>
  field.type === "choice" && field.options.length > 0
    ? (field.options[0] ?? SAMPLE.choice)
    : SAMPLE[field.type];

/**
 * How the caller's answer appears.
 *
 * Keypad capture shows keys pressed rather than words said, because that is the difference
 * the operator is choosing between and it is otherwise invisible.
 */
export const heardAs = (field: CapturedField, value: string): string =>
  field.capture === "keypad" ? `presses ${spaced(value)}` : value;

/**
 * How the agent checks it back.
 *
 * Spell-back spells whatever it is given, whatever the kind — that is the point of
 * choosing it over read-back, and a caller who asked for spelling gets spelling.
 */
export const readBackOf = (field: CapturedField, value: string): string => {
  const said = spellsOut(field) ? spaced(value) : value;
  return field.confirm === "spellback"
    ? `${said} — have I got that right?`
    : `That's ${said} — is that right?`;
};
