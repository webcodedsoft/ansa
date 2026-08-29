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

export const nameOf = (person: ContactSummary): string => {
  if (person.displayName !== null && person.displayName.trim() !== "") return person.displayName;
  const captured = person.values.find((value) => value.fieldType === NAME_TYPE);
  return captured?.value.trim() !== undefined && captured.value.trim() !== ""
    ? captured.value
    : "Unnamed caller";
};
