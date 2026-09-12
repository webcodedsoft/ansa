import { z } from "zod";

import { emailAddress } from "@/lib/patterns";

/**
 * What the sign-in form is allowed to submit.
 *
 * This is not a second copy of the API's rules and must not become one. The API's schema is
 * the authority — it enforces the password length, the address format and the organisation's
 * existence, and it is the only thing that can, because it is the only side that knows. What
 * this does is catch the two mistakes that are worth catching without a round trip, and
 * attach them to the field that caused them so the form can point at it.
 */
export const credentialsSchema = z.object({
  email: emailAddress,

  // Not trimmed, unlike everything else on this form. A leading or trailing space is a
  // legitimate character in a passphrase, and quietly removing it produces a password that
  // works here and fails everywhere the person actually typed it.
  password: z.string().min(1, "Enter your password."),

  /**
   * Empty on the first pass, because the form does not yet know whether there is a choice
   * to make. Set on the second pass, when the address turned out to belong to several.
   */
  organisationId: z.union([z.literal(""), z.uuid("Choose an organisation.")]),
});

export type Credentials = z.infer<typeof credentialsSchema>;

/**
 * The API's minimum, repeated here only so a short password fails on its own field instead
 * of arriving as a 422 with nothing to attach it to. If the API's rule changes this is stale
 * in the safe direction: it refuses what the API would have taken.
 */
const MIN_PASSWORD = 12;

const newPassword = z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`);

/**
 * Creating an organisation and the account that owns it.
 *
 * An address that already has an account may create a second organisation, and does it with
 * the password it already has — so this is not only a "new user" form, and the API refuses a
 * wrong password with the same answer a failed sign-in gets.
 */
/** Your own account. The email is the sign-in identity and is not on this form. */
export const profileSchema = z.object({
  displayName: z.string().trim().min(1, "Enter the name you want to be shown as.").max(200, "Use at most 200 characters."),
});
export type ProfileInput = z.infer<typeof profileSchema>;

/**
 * The current password is not length-checked, for the reason sign-in does not check it:
 * whatever they have is what they have. The new one meets the minimum, and the confirmation
 * catches the typo that would otherwise lock them out of their own account.
 */
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword,
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "This does not match the new password.",
  });
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;

/** Closing your account asks for the password again; the box cannot be empty. */
export const accountClosureSchema = z.object({
  password: z.string().min(1, "Enter your password to confirm."),
});

export const signUpSchema = z
  .object({
    organisationName: z
      .string()
      .trim()
      .min(1, "What is the organisation called?")
      .max(120, "That name is too long."),
    displayName: z
      .string()
      .trim()
      .min(1, "What should your colleagues call you?")
      .max(200, "That name is too long."),
    email: emailAddress,
    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "These do not match.",
  });

export type SignUp = z.infer<typeof signUpSchema>;

/**
 * Redeeming an invitation, which is the other way a person comes into existence.
 *
 * There is no sign-up. `users` has no INSERT grant for the application role at all — an
 * operator provisions the organisation and mints the first invitation out of band, and
 * everyone after that is invited by somebody already inside. So this form is the front door,
 * and without it a freshly provisioned organisation has a dashboard nobody can enter.
 */
export const acceptInvitationSchema = z
  .object({
    token: z.string().trim().min(1, "The invitation link is missing its token."),
    displayName: z
      .string()
      .trim()
      .min(1, "What should the agent's operators call you?")
      .max(120, "That name is too long."),

    password: newPassword,
    confirmPassword: z.string(),
  })
  .refine((value) => value.password === value.confirmPassword, {
    path: ["confirmPassword"],
    message: "These do not match.",
  });

export type AcceptInvitation = z.infer<typeof acceptInvitationSchema>;
