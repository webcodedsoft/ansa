"use client";

import { KeyRound, TriangleAlert, UserRound } from "lucide-react";
import { startTransition, useActionState, useRef, useState } from "react";

import { Button, Card, ConfirmDialog, Notice, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import {
  changePassword,
  deleteAccount,
  saveProfile,
  type ClosureState,
  type PasswordState,
  type ProfileState,
} from "../auth.actions";

const PROFILE_START: ProfileState = idleForm();
const PASSWORD_START: PasswordState = idleForm();
const CLOSURE_START: ClosureState = idleForm();

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
  useFailureToast(state);
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

/**
 * Closing the account. A password, a danger button, and a dialog that says what happens —
 * in that order, because the dialog is the last chance and should not be the first place
 * the consequences are read.
 *
 * The password is read off the form when the dialog confirms, not held in state: the field
 * is the only place it lives until the request goes.
 */
export const DeleteAccountForm = ({ organisationName }: { readonly organisationName: string }) => {
  const [state, action, pending] = useActionState(deleteAccount, CLOSURE_START);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2 text-[var(--bad)]">
          <TriangleAlert aria-hidden className="size-4" />
          Delete account
        </span>
      }
      description="Closes your account everywhere, not just here. There is no undo on this surface."
      className="border-[color-mix(in_srgb,var(--bad)_35%,var(--hairline))]"
    >
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          setConfirming(true);
        }}
        className="flex flex-col gap-4"
      >

        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-[var(--ink-2)]">
          <li>· You leave {organisationName} and every other organisation you belong to.</li>
          <li>· Every session you hold is signed out, including this one.</li>
          <li>· Calls you reviewed and values you corrected keep your name.</li>
          <li>· Your email address is released — you can sign up with it again later, as a new account.</li>
          <li>· If you are the only owner of an organisation, make somebody else an owner first; this is refused until you do.</li>
        </ul>

        <TextField
          label="Your password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="sm:max-w-[26rem]"
          hint="Asked for again so a session left open on another machine cannot do this."
          error={state.fieldErrors["password"]}
        />

        <div>
          <Button type="submit" variant="danger" pending={pending}>
            Delete my account
          </Button>
        </div>

        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            const current = form.current;
            if (current === null) return;
            const data = new FormData(current);
            startTransition(() => action(data));
          }}
          title="Delete your account?"
          confirmLabel="Delete my account"
          pending={pending}
        >
          You are signed out of everything the moment this is confirmed, and your account
          cannot be reopened. Your name stays on the work you did.
        </ConfirmDialog>
      </form>
    </Card>
  );
};
