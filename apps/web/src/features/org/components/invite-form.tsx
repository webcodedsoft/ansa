"use client";

import { useActionState } from "react";

import { Card, Notice, Row, SelectField, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { invite, type InviteState } from "../org.actions";

const START: InviteState = idleForm();

/**
 * Invite someone, and show the link exactly once.
 *
 * The API hands back the redemption token only on this response — it is not on the
 * invitation row `listInvitations` returns, and there is no endpoint that will produce it a
 * second time. So the moment this form succeeds is the only moment the link can be shown;
 * losing this screen without copying it means sending a fresh invitation instead.
 */
export const InviteForm = () => {
  const [state, action, pending] = useActionState(invite, START);
  const errors = state.fieldErrors;
  const invited = state.status === "succeeded" ? state.data : null;

  return (
    <Card title="Invite someone" description="They join with the role you choose below.">
      <Stack>
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
            <div>
              <SubmitButton pending={pending} idle="Send invitation" busy="Sending…" />
            </div>
            {(state.status === "failed" || state.status === "invalid") && (
              <Notice tone="error">{state.message}</Notice>
            )}
          </Stack>
        </form>

        {invited !== null && (
          <Notice tone="ok">
            <p>
              Invited <strong>{invited.email}</strong> as {invited.role}. Redemption link, shown
              once:
            </p>
            <p className="mt-2 rounded-md border border-[var(--hairline)] bg-[var(--surface-2)] px-2.5 py-2 font-mono text-[12.5px] break-all">
              {`/accept-invitation?token=${invited.token}`}
            </p>
            <p className="mt-2 text-[12.5px] text-[var(--ink-3)]">
              Copy this now — the API will not show this token again. Leaving this page, or
              sending another invitation, loses it for good; the invitation itself stays valid
              until it expires or is revoked, but a new one would need to be sent to get another
              link.
            </p>
          </Notice>
        )}
      </Stack>
    </Card>
  );
};
