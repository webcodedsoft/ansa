"use client";

import { useActionState, useState } from "react";

import { Button, Modal, Notice, Row, Tag, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import { setStatusAction, type SetStatusState } from "../campaigns.actions";
import { campaignTone } from "../campaigns.display";
import type { CampaignStatus } from "../campaigns.service";
import { moveLabel, nextStatuses } from "../campaigns.transitions";

const START: SetStatusState = idleForm();

/**
 * The campaign's state, and the moves it may make from here.
 *
 * Only the legal moves are offered — the map mirrors the API's own transitions — so the
 * common path never earns a refusal. A campaign can still change under two people at once,
 * though, so a move can come back a 409 that names why; that lands in the notice below rather
 * than as a generic failure. A finished campaign is terminal and shows no controls at all.
 */
export const CampaignStatusControl = ({
  campaignId,
  status,
  pauseReason,
  canWrite,
}: {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  /** Why it is paused, shown beside the badge so the next person does not have to ask. */
  readonly pauseReason?: string | null;
  readonly canWrite: boolean;
}) => {
  const [state, dispatch, pending] = useActionState(setStatusAction, START);
  useFormToast(state, (data) => `Campaign is now ${data.status}.`);

  /* Pausing asks one question first. Every other move fires on the click; a pause opens a
     small dialog for the reason, because "Paused" on a badge answers what and not why, and
     the why is the only thing the next person needs. Optional — an empty reason still pauses. */
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");

  const moves = nextStatuses(status);

  const move = (to: CampaignStatus, why: string | null = null) => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("status", to);
    if (why !== null && why.trim() !== "") form.set("reason", why.trim());
    dispatch(form);
  };

  return (
    <div>
      <Row>
        <Tag tone={campaignTone[status]}>{status}</Tag>
        {status === "paused" && pauseReason !== null && pauseReason !== undefined && (
          <span className="text-[12.5px] text-[var(--ink-2)]">— {pauseReason}</span>
        )}
        {canWrite &&
          moves.map((to) => (
            <Button
              key={to}
              size="sm"
              variant={to === "running" ? "primary" : "secondary"}
              disabled={pending}
              onClick={() => (to === "paused" ? setAsking(true) : move(to))}
            >
              {moveLabel(status, to)}
            </Button>
          ))}
        {canWrite && moves.length === 0 && (
          <span className="text-[12.5px] text-[var(--ink-3)]">
            This campaign is finished. Nothing more will be dialled.
          </span>
        )}
      </Row>

      {state.status === "failed" && (
        <Notice tone="error" className="mt-2.5">
          {state.message}
        </Notice>
      )}

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Pause this campaign"
        description="Nothing more is dialled until it is resumed. A call already in progress finishes. Say why, in a line, for whoever opens this tomorrow."
        footer={
          <>
            <Button onClick={() => setAsking(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => {
                setAsking(false);
                move("paused", reason);
              }}
            >
              Pause
            </Button>
          </>
        }
      >
        <TextField
          label="Why"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. waiting for legal sign-off on the new opening"
          hint="Optional. Shown beside the badge while it is paused, and cleared when it resumes."
        />
      </Modal>
    </div>
  );
};
