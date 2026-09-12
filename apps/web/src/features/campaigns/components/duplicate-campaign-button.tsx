"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, Modal, Notice, Stack, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { duplicateCampaignAction, type DuplicateState } from "../campaigns.actions";

const START: DuplicateState = idleForm();

/**
 * Run the same campaign again at a fresh list.
 *
 * A brief freezes the moment a campaign starts, deliberately — the reason somebody was rung
 * must not change while they are being rung. The cost of that was no way to run the same
 * words twice: last month's follow-up had to be retyped, flow and all.
 *
 * What comes across is everything written and nothing done. No contacts, no calls, no start
 * time, and the copy is a draft. The API enforces that; the description below says it,
 * because "duplicate" on a thing that rings people is a word somebody could reasonably read
 * as "ring them all again".
 *
 * A plain `Button` rather than `SubmitButton` in the footer: the modal's footer sits outside
 * any form, and `SubmitButton` is a submit control with no click handler. Same shape as
 * `RoutingCard` — build the FormData and call the action inside a transition.
 */
export const DuplicateCampaignButton = ({
  campaignId,
  name,
}: {
  readonly campaignId: string;
  readonly name: string;
}) => {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(duplicateCampaignAction, START);
  const [copyName, setCopyName] = useState(`${name} (copy)`);

  const create = (): void => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("name", copyName);
    startTransition(() => action(form));
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Duplicate
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Duplicate this campaign"
        description="The brief, the conversation, the outcomes and the calling window come across. Nobody does — the copy is a draft with an empty list."
        footer={
          <>
            <Button onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button pending={pending}
              variant="primary"
              disabled={pending || copyName.trim() === ""}
              aria-busy={pending}
              onClick={create}
            >
              "Create the copy"
            </Button>
          </>
        }
      >
        <Stack>
          {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
          <TextField
            label="Name"
            value={copyName}
            onChange={(event) => setCopyName(event.target.value)}
            placeholder="e.g. November arrears follow-up"
          />
        </Stack>
      </Modal>
    </>
  );
};
