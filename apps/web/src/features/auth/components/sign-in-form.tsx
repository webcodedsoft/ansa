"use client";

import { useActionState } from "react";

import { SelectField, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { signIn, type SignInState } from "../auth.actions";

/**
 * The initial state lives here rather than beside the action, because a `"use server"`
 * module may only export async functions — exporting a plain object from one is a build
 * error, not a style preference.
 */
const START: SignInState = idleForm();

export const SignInForm = () => {
  const [state, action, pending] = useActionState(signIn, START);
  useFailureToast(state);
  const choices = state.data?.choices ?? [];
  const choosing = choices.length > 0;

  return (
    <form action={action}>
      <Stack>

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
          autoComplete="current-password"
          required
          error={state.fieldErrors["password"]}
        />

        {choosing && (
          <SelectField
            label="Organisation"
            name="organisationId"
            required
            defaultValue=""
            error={state.fieldErrors["organisationId"]}
            hint="This address can sign in to more than one. Pick the one to work in."
          >
            <option value="" disabled>
              Choose one
            </option>
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.name} · {choice.role}
              </option>
            ))}
          </SelectField>
        )}

        <SubmitButton
          pending={pending}
          idle={choosing ? "Continue" : "Sign in"}
          className="w-full"
        />
      </Stack>
    </form>
  );
};
