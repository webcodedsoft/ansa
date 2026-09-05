import { z } from "zod";

/**
 * What the add-a-contact form must carry before it is worth a round trip.
 *
 * Only the phone is required, because a contact is a number first and a name second — the same
 * order the directory shows them in. The API validates the number's shape and returns a field
 * error when it cannot read it; this only insists that there is something there to send, so an
 * empty submit is answered beside the box rather than by the server.
 *
 * A blank name or note is dropped rather than sent as "", so a hand-added contact with no name
 * looks in the database exactly like a called-in one with none — an empty string would be a
 * third state that reads as "named, with nothing".
 */
const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((value) => (value === "" ? undefined : value))
    .optional();

export const addContactSchema = z.object({
  phone: z.string().trim().min(1, "Enter a phone number."),
  displayName: optionalText(120, "That name is too long."),
  notes: optionalText(2000, "That note is too long."),
});

export type AddContactInput = z.infer<typeof addContactSchema>;
