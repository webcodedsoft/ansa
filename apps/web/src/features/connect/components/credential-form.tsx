"use client";

import { useActionState, useEffect, useState } from "react";

import { Notice, Row, SelectField, Stack, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { saveCredential, type SaveCredentialState } from "../connect.actions";
import { CREDENTIAL_KINDS, type CredentialKind } from "../connect.schema";

const START: SaveCredentialState = idleForm();

const KIND_LABEL: Record<CredentialKind, string> = {
  bearer: "Bearer token",
  header: "Custom header",
  basic: "Username and password",
  signing: "Signing secret",
};

/**
 * Store a credential, or rotate one that already exists.
 *
 * Both are the same PUT under the hood — the API does not distinguish "new" from "replace
 * what's there" — so this is one component either way. The only difference is whether the
 * name is a field the caller sets (`mode: "add"`) or a fact about the row already being
 * rotated (`mode: "rotate"`, name fixed and sent as a hidden field).
 *
 * There is deliberately no way to see a stored value here, including this form: every field
 * below is `type="password"` so a rotate never prefills with — or displays — the secret it
 * is replacing, because there is nothing to prefill it with. The API does not return one.
 */
export const CredentialForm = ({
  mode,
  fixedRef,
  onSaved,
}: {
  readonly mode: "add" | "rotate";
  readonly fixedRef?: string;
  readonly onSaved?: () => void;
}) => {
  const [state, action, pending] = useActionState(saveCredential, START);
  const [kind, setKind] = useState<CredentialKind>("bearer");

  useFormToast(state, (data) => (mode === "add" ? `Stored ${data.ref}.` : `Rotated ${data.ref}.`));

  // Deliberately keyed on `state.status` alone: this should fire once when a submission
  // completes, not on every render where the caller happens to pass a new `onSaved` closure.
  useEffect(() => {
    if (state.status === "succeeded") onSaved?.();
  }, [state.status, onSaved]);

  const errors = state.fieldErrors;

  return (
    <form action={action}>
      <Stack gap="sm">
        {fixedRef === undefined ? (
          <TextField
            label="Name"
            name="ref"
            maxLength={64}
            required
            placeholder="billing_api"
            hint="Lowercase, underscores. Tools reference the credential by this name; the value itself is never shown again."
            error={errors["ref"]}
          />
        ) : (
          <input type="hidden" name="ref" value={fixedRef} />
        )}

        <SelectField
          label="Kind"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as CredentialKind)}
        >
          {CREDENTIAL_KINDS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {KIND_LABEL[candidate]}
            </option>
          ))}
        </SelectField>

        {kind === "bearer" && (
          <TextField label="Token" name="token" type="password" required error={errors["token"]} />
        )}

        {kind === "header" && (
          <Row>
            <TextField
              label="Header name"
              name="header"
              required
              error={errors["header"]}
              className="min-w-40 flex-1"
            />
            <TextField
              label="Value"
              name="value"
              type="password"
              required
              error={errors["value"]}
              className="min-w-40 flex-1"
            />
          </Row>
        )}

        {kind === "basic" && (
          <Row>
            <TextField
              label="Username"
              name="username"
              required
              error={errors["username"]}
              className="min-w-40 flex-1"
            />
            <TextField
              label="Password"
              name="password"
              type="password"
              required
              error={errors["password"]}
              className="min-w-40 flex-1"
            />
          </Row>
        )}

        {kind === "signing" && (
          <TextField label="Secret" name="secret" type="password" required error={errors["secret"]} />
        )}

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error">{state.message}</Notice>
        )}

        <div>
          <SubmitButton pending={pending} idle={mode === "add" ? "Store credential" : "Rotate"} busy="Saving…" />
        </div>
      </Stack>
    </form>
  );
};
