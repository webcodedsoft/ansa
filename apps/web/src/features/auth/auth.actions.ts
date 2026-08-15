"use server";

import { redirect } from "next/navigation";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import { acceptInvitationSchema, credentialsSchema, signUpSchema } from "./auth.schema";
import {
  acceptInvitation,
  createOrganisation,
  organisationsFor,
  signInTo,
  signOutEverywhere,
  type OrganisationChoice,
} from "./auth.service";

/**
 * What the sign-in form gets back when it has to ask which organisation.
 *
 * A successful sign-in never returns — it redirects — so the only `succeeded` state this
 * action can produce is "there is more than one, pick".
 */
export interface OrganisationPrompt {
  readonly choices: readonly OrganisationChoice[];
}

export type SignInState = FormState<OrganisationPrompt>;

/**
 * Sign in, asking which organisation only when there is a genuine choice.
 *
 * The API splits this into two calls — list the organisations for an email and password,
 * then open a session against one — because an address can belong to several. Most people
 * belong to one, so asking them to pick from a list of one would be a step that serves the
 * API's shape rather than theirs. The picker appears on the second pass, and only when the
 * question is real.
 *
 * `redirect` throws internally, which is why it sits outside every `try`. Catching it would
 * turn a successful sign-in into "the request failed".
 */
export const signIn = async (_previous: SignInState, form: FormData): Promise<SignInState> => {
  const parsed = credentialsSchema.safeParse({
    email: form.get("email") ?? "",
    password: form.get("password") ?? "",
    organisationId: form.get("organisationId") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  const { email, password } = parsed.data;
  let organisationId = parsed.data.organisationId;

  if (organisationId === "") {
    let choices: readonly OrganisationChoice[];
    try {
      choices = await organisationsFor(email, password);
    } catch (error) {
      return failedForm(failureMessage(error));
    }

    const only = choices[0];
    if (only === undefined) {
      // Deliberately identical whether the address is unknown or the password is wrong. The
      // API answers both the same way and takes the same time doing it; a form that told
      // them apart would undo that and become an account-existence oracle.
      return failedForm("Those details did not match an account.");
    }
    if (choices.length > 1) return succeededForm({ choices });
    organisationId = only.id;
  }

  try {
    await signInTo(email, password, organisationId);
  } catch (error) {
    return failedForm(failureMessage(error));
  }

  redirect("/calls");
};

export const signOut = async (): Promise<void> => {
  await signOutEverywhere();
  redirect("/sign-in");
};

export type SignUpState = FormState<null>;

/**
 * Create an organisation and sign into it.
 *
 * Redirects on success rather than returning, for the same reason `signIn` does: the API
 * hands back a session, the cookie is set, and there is nothing left to render on this
 * screen that is more useful than the calls page.
 */
export const signUp = async (_previous: SignUpState, form: FormData): Promise<SignUpState> => {
  const parsed = signUpSchema.safeParse({
    organisationName: form.get("organisationName") ?? "",
    displayName: form.get("displayName") ?? "",
    email: form.get("email") ?? "",
    password: form.get("password") ?? "",
    confirmPassword: form.get("confirmPassword") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    await createOrganisation(
      parsed.data.organisationName,
      parsed.data.email,
      parsed.data.password,
      parsed.data.displayName,
    );
  } catch (error) {
    // A 401 here means the address already has an account and this password is not it. The
    // API says so in the same words a failed sign-in gets, and repeating them is right: a
    // friendlier message would confirm the address is registered.
    return failedForm(failureMessage(error));
  }

  redirect("/calls");
};

export interface Accepted {
  readonly createdUser: boolean;
}

export type AcceptInvitationState = FormState<Accepted>;

/**
 * Redeem an invitation and set a password.
 *
 * It does not sign the person in afterwards, and that is not laziness. The response says
 * which organisation they joined but not which address was invited — the token carried that,
 * and the token is spent. Signing in would mean asking for the email again on a screen that
 * looks like it already knows, so it sends them to sign in instead, which is where they will
 * start every day after this one anyway.
 */
export const acceptInvite = async (
  _previous: AcceptInvitationState,
  form: FormData,
): Promise<AcceptInvitationState> => {
  const parsed = acceptInvitationSchema.safeParse({
    token: form.get("token") ?? "",
    displayName: form.get("displayName") ?? "",
    password: form.get("password") ?? "",
    confirmPassword: form.get("confirmPassword") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await acceptInvitation(
      parsed.data.token,
      parsed.data.password,
      parsed.data.displayName,
    );
    return succeededForm({ createdUser: result.createdUser });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
