"use client";

import { Check, Copy, UserPlus } from "lucide-react";
import { useActionState, useState } from "react";

import { Button, Modal, Notice, Row, SelectField, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

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
      <Stack gap="sm">
        <Row className="items-start">
          <TextField
            label="Email"
            name="email"
            type="email"
            required
            placeholder="name@example.com"
            error={errors["email"]}
            className="min-w-64 flex-1"
          />
          <SelectField label="Role" name="role" defaultValue="member" className="min-w-36">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </SelectField>
        </Row>
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}
        <Row>
          <SubmitButton pending={pending} idle="Send invitation" />
          <Button onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        </Row>
      </Stack>
    </form>
  );
};

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
        description="They join with the role you choose. Owners and admins can change it afterwards."
      >
        {/* Mounted only while open, so a second invitation starts from a clean form rather
            than showing the last link again. */}
        {open && <InviteForm onDone={() => setOpen(false)} />}
      </Modal>
    </>
  );
};
