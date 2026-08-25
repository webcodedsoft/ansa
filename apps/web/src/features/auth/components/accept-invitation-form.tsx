"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Notice, Stack, SubmitButton, TextField, buttonClass } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { acceptInvite, type AcceptInvitationState } from "../auth.actions";

const START: AcceptInvitationState = idleForm();

export const AcceptInvitationForm = ({ token }: { readonly token: string }) => {
  const [state, action, pending] = useActionState(acceptInvite, START);

  if (state.status === "succeeded") {
    return (
      <Stack>
        <Notice tone="ok">
          {state.data?.createdUser === true
            ? "Your account is ready."
            : "You have joined the organisation."}{" "}
          Sign in with the address the invitation was sent to.
        </Notice>
        {/* This was the oldest button in the app and it showed: white ink on the light teal
            accent, and a hover colour `--color-accent-hover` that no stylesheet defines, so
            it never changed under the pointer. */}
        <Link href="/sign-in" className={buttonClass("primary", "md", "w-full")}>
          Sign in
        </Link>
      </Stack>
    );
  }

  return (
    <form action={action}>
      <Stack>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        {/* The token comes from the link and is never shown or editable. Rendering it in a
            visible field would invite somebody to paste the wrong one, and there is nothing
            useful to do with it by hand. */}
        <input type="hidden" name="token" value={token} />
        {state.fieldErrors["token"] !== undefined && (
          <Notice tone="error">
            {state.fieldErrors["token"]} Ask whoever invited you for a fresh link.
          </Notice>
        )}

        <TextField
          label="Your name"
          name="displayName"
          autoComplete="name"
          required
          error={state.fieldErrors["displayName"]}
          hint="Shown on the calls and configuration versions you touch."
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          error={state.fieldErrors["password"]}
        />
        <TextField
          label="Password again"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          error={state.fieldErrors["confirmPassword"]}
        />

        <SubmitButton
          pending={pending}
          idle="Create account"
          busy="Creating…"
          className="w-full"
        />
      </Stack>
    </form>
  );
};
