"use client";

import { useActionState } from "react";

import { Notice, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { signUp, type SignUpState } from "../auth.actions";

const START: SignUpState = idleForm();

export const SignUpForm = () => {
  const [state, action, pending] = useActionState(signUp, START);

  return (
    <form action={action}>
      <Stack>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        <TextField
          label="Organisation"
          name="organisationName"
          autoComplete="organization"
          required
          maxLength={120}
          error={state.fieldErrors["organisationName"]}
          hint="What your callers would call you. It can be changed later."
        />
        <TextField
          label="Your name"
          name="displayName"
          autoComplete="name"
          required
          maxLength={200}
          error={state.fieldErrors["displayName"]}
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          error={state.fieldErrors["email"]}
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          error={state.fieldErrors["password"]}
          hint="If this address already has an account, use its existing password."
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
          idle="Create organisation"
          busy="Creating…"
          className="w-full"
        />
      </Stack>
    </form>
  );
};
