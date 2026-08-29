import type { ContactSummary } from "./contacts.service";

/**
 * How a contact is named and labelled on screen.
 *
 * Shared between the list and the detail page so the same person is called the same thing in
 * both. An operator's correction wins over the captured name, which is the point of storing
 * them separately: the office knows things the caller did not say clearly.
 */

const NAME_TYPE = "name";

export const nameOf = (person: ContactSummary): string => {
  if (person.displayName !== null && person.displayName.trim() !== "") return person.displayName;
  const captured = person.values.find((value) => value.fieldType === NAME_TYPE);
  return captured?.value.trim() !== undefined && captured.value.trim() !== ""
    ? captured.value
    : "Unnamed caller";
};

/** `callbackNumber` reads as "Callback number", without a table of every possible key. */
export const valueLabel = (fieldKey: string): string => {
  const spaced = fieldKey
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
};
