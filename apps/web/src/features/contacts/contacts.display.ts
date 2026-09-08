import type { ContactSummary } from "./contacts.service";

/**
 * How a contact is named on screen.
 *
 * Shared between the list and the detail page so the same person is called the same thing in
 * both. An operator's correction wins over the captured name, which is the point of storing
 * them separately: the office knows things the caller did not say clearly.
 *
 * The captured name is read here and nowhere else on these pages. It is identity — what to
 * call this person — rather than collected data, which belongs on Collected data.
 */

const NAME_TYPE = "name";

/**
 * How many captured values a row shows before it stops. Three is what fits on one line at
 * the directory's width; a fourth pushes the last-call column around on a narrow window.
 */
const CONTEXT_LIMIT = 3;

/**
 * What this person wanted, in their own captured words.
 *
 * The directory's middle column. A name and a number identify somebody, but they are not why
 * you ring back — "Lekki Phase 1 · ₦4.5m/yr" is. These are the same confirmed captures the
 * detail page lists, joined and cut to a line.
 *
 * The name is excluded because it is already the row's heading, and repeating it here would
 * spend the only line on the one thing the reader has just read.
 *
 * Empty string when they have confirmed nothing but a name — the row then shows no context
 * rather than an em dash, because a placeholder in every unidentified row is noise in the
 * column that is meant to be scanned.
 */
export const contextOf = (person: ContactSummary): string =>
  person.values
    .filter((value) => value.fieldType !== NAME_TYPE)
    .map((value) => value.value.trim())
    .filter((value) => value !== "")
    .slice(0, CONTEXT_LIMIT)
    .join(" · ");

export const nameOf = (person: ContactSummary): string => {
  if (person.displayName !== null && person.displayName.trim() !== "") return person.displayName;
  const captured = person.values.find((value) => value.fieldType === NAME_TYPE);
  return captured?.value.trim() !== undefined && captured.value.trim() !== ""
    ? captured.value
    : "Unnamed caller";
};

/**
 * Two letters standing for a person, or the last two digits when nobody has given a name.
 *
 * Shared by the directory row and the record header for the same reason `nameOf` is: the
 * circle you picked out of a list must be the circle at the top of the page you land on.
 */
export const initialsOf = (person: ContactSummary): string => {
  const name = nameOf(person);
  if (name !== "Unnamed caller") {
    const parts = name.split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : (parts[0]?.[1] ?? "");
    return `${first}${second}`.toUpperCase();
  }
  return person.phone.replace(/\D/g, "").slice(-2);
};
