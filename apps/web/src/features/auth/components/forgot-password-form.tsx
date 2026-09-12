"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Notice, Stack, SubmitButton, TextField, buttonClass } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFailureToast } from "@/stores/toast.store";

import { forgotPassword, type ForgotPasswordState } from "../auth.actions";

const START: ForgotPasswordState = idleForm();

/**
 * One field, one sentence back. The sentence is the same whether the address has an
 * account or not, and the form stays on it rather than returning to the field: a second
 * submit would only send a second link, and the first has not arrived yet.
 */
export const ForgotPasswordForm = () => {
  const [state, action, pending] = useActionState(forgotPassword, START);
  useFailureToast(state);

  if (state.status === "succeeded") {
    return (
      <Stack>
        <Notice tone="ok">{state.message}</Notice>
        <p className="text-[13px] text-[var(--ink-3)]">
          Nothing arrived? Check the spam folder, and make sure the address is the one you sign in with.
        </p>
        <Link href="/sign-in" className={buttonClass("secondary", "md", "w-full")}>
          Back to sign in
        </Link>
      </Stack>
    );
  }

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
          hint="The address you sign in with."
        />
        <SubmitButton pending={pending} idle="Send me a link" className="w-full" />
      </Stack>
    </form>
  );
};
