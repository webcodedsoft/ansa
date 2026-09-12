"use client";

import { KeyRound, UserRound } from "lucide-react";
import { useActionState } from "react";

import { Card, Notice, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { changePassword, saveProfile, type PasswordState, type ProfileState } from "../auth.actions";

const PROFILE_START: ProfileState = idleForm();
const PASSWORD_START: PasswordState = idleForm();

/**
 * The name you are shown as. The email sits beside it read-only because it is the sign-in
 * identity: changing it is a new invitation, which the organisation's owners see happen,
 * rather than a field anyone can quietly retype.
 */
export const ProfileForm = ({
  displayName,
  email,
}: {
  readonly displayName: string;
  readonly email: string;
}) => {
  const [state, action, pending] = useActionState(saveProfile, PROFILE_START);
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <UserRound aria-hidden className="size-4 text-[var(--ink-3)]" />
          Profile
        </span>
      }
      description="How you appear to the people you work with — on the members list, on the calls you review and the values you correct."
    >
      <form action={action} className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && <Notice tone="ok">{state.message}</Notice>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Name"
            name="displayName"
            defaultValue={state.data?.displayName ?? displayName}
            autoComplete="name"
            required
            error={state.fieldErrors["displayName"]}
          />
          <TextField
            label="Email"
            name="email"
            value={email}
            readOnly
            mono
            hint="Your sign-in address. To change it, ask an owner to invite the new address — a change of identity should be seen, not typed."
          />
        </div>
        <div>
          <SubmitButton pending={pending} idle="Save" />
        </div>
      </form>
    </Card>
  );
};

/**
 * Current, new, confirm. The confirmation exists to catch the one typo that locks a person
 * out of their own account; the current password is what makes a stolen session unable to
 * take the account with it. Nothing typed here is kept in state after the submit.
 */
export const PasswordForm = () => {
  const [state, action, pending] = useActionState(changePassword, PASSWORD_START);
  const succeeded = state.status === "succeeded";
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound aria-hidden className="size-4 text-[var(--ink-3)]" />
          Password
        </span>
      }
      description="Changing it signs out every other session you hold — every organisation, every device. This one stays."
    >
      {/* Keyed on the success stamp so the fields empty once the change lands, without
          holding the passwords in state to clear them. */}
      <form key={state.data?.changedAt ?? "unchanged"} action={action} className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {succeeded && <Notice tone="ok">{state.message}</Notice>}
        <TextField
          label="Current password"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          className="sm:max-w-[26rem]"
          error={state.fieldErrors["currentPassword"]}
        />
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            hint="At least 12 characters. A sentence you will remember beats a word you will not."
            error={state.fieldErrors["newPassword"]}
          />
          <TextField
            label="Confirm new password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            error={state.fieldErrors["confirmPassword"]}
          />
        </div>
        <div>
          <SubmitButton pending={pending} idle="Change password" />
        </div>
      </form>
    </Card>
  );
};
