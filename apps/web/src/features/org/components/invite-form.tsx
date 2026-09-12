"use client";

import { Check, Copy, UserPlus } from "lucide-react";
import { useActionState, useState } from "react";

import { Button, Modal, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { invite, type InviteState } from "../org.actions";

const START: InviteState = idleForm();

/**
 * Invite someone, and show the link exactly once.
 *
 * The API hands back the redemption token only on this response — it is not on the
 * invitation row `listInvitations` returns, and there is no endpoint that will produce it a
 * second time. So the moment this form succeeds is the only moment the link can be shown;
 * closing the modal without copying it means sending a fresh invitation instead. Which is
 * why the modal does not close itself on success, and why there is a Copy button rather than
 * a run of text somebody has to select by hand.
 */
const InviteForm = ({ onDone }: { readonly onDone: () => void }) => {
  const [state, action, pending] = useActionState(invite, START);
  useFailureToast(state);
  const [copied, setCopied] = useState(false);
  const errors = state.fieldErrors;
  const invited = state.status === "succeeded" ? state.data : null;

  if (invited !== null) {
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    const link = `${origin}/accept-invitation?token=${invited.token}`;
    return (
      <Stack gap="sm">
        <p className="m-0 text-[13.5px]">
          Invited <strong>{invited.email}</strong> as {invited.role}. Send them this link — it
          is shown once.
        </p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-2 font-mono text-[12.5px]">
            {link}
          </code>
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard.writeText(link).then(() => setCopied(true));
            }}
          >
            {copied ? (
              <Check aria-hidden className="size-3.5" />
            ) : (
              <Copy aria-hidden className="size-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="m-0 text-[12.5px] text-[var(--ink-3)]">
          The link works until the invitation expires or is revoked. Closing this without
          copying it means sending a new invitation to get another.
        </p>
        <div>
          <Button onClick={onDone}>Done</Button>
        </div>
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
          required
          autoFocus
          placeholder="name@example.com"
          error={errors["email"]}
        />

        {/* Three cards, not a dropdown. A native select opened over the modal and scrolled
            the title out of view to make room for its popup; and "Admin" on its own does
            not tell anybody what an admin can do. Each card says what the role holds, in
            the words `capability.ts` grants — nothing here is a promise the API does not
            keep. */}
        <fieldset className="m-0 min-w-0 border-0 p-0">
          <legend className="mb-2 text-[12.5px] font-medium">Role</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {ROLES.map((role) => (
              <label
                key={role.value}
                className="group flex cursor-pointer flex-col gap-1 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3 py-2.5 transition-colors has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-soft)] hover:border-[var(--ink-3)]"
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="role"
                    value={role.value}
                    defaultChecked={role.value === "member"}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className="grid size-4 flex-none place-items-center rounded-full border border-[var(--ink-3)] peer-checked:border-[var(--accent)] peer-checked:bg-[var(--accent)]"
                  >
                    <Check className="size-2.5 text-[var(--accent-on)] opacity-0 peer-checked:opacity-100" />
                  </span>
                  <span className="text-[13px] font-medium">{role.label}</span>
                </span>
                <span className="pl-6 text-[11.5px] leading-snug text-[var(--ink-3)]">{role.can}</span>
              </label>
            ))}
          </div>
        </fieldset>


        {/* The modal's own footer band, drawn here because the pending state and the form
            live in this component. Same rule as everywhere: actions right, the deliberate
            one first. */}
        <div className="-mx-[18px] -mb-[18px] flex items-center justify-end gap-2 border-t border-[var(--hairline)] px-[18px] py-3">
          <Button onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <SubmitButton pending={pending} idle="Send invitation" />
        </div>
      </Stack>
    </form>
  );
};

/**
 * What each role holds, in the words the API grants it. Read from `capability.ts`, not
 * guessed: a member reads; an admin changes everything about the work but not the people; an
 * owner does both.
 */
const ROLES = [
  {
    value: "member",
    label: "Member",
    can: "Sees calls, contacts, campaigns and appointments. Changes nothing.",
  },
  {
    value: "admin",
    label: "Admin",
    can: "Everything about the work — agents, calls, contacts, campaigns, appointments. Not who is in the organisation.",
  },
  {
    value: "owner",
    label: "Owner",
    can: "Everything an admin can, and invites, removes and changes the roles of people.",
  },
] as const;

/** The header action: a button, and the form in a modal the way Contacts adds a person. */
export const InviteMember = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        <UserPlus aria-hidden className="size-3.5" />
        Invite someone
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Invite someone"
        description="They join with the role you choose. An owner can change it afterwards."
      >
        {/* Mounted only while open, so a second invitation starts from a clean form rather
            than showing the last link again. */}
        {open && <InviteForm onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
};
