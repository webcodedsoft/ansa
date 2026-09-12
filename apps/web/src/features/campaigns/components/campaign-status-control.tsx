"use client";

import { useActionState, useState, type ReactNode } from "react";

import { Button, Modal, Row, Tag, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast, useFailureToast } from "@/stores/toast.store";

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
 *
 * It owns the whole top row rather than only its own half. The page used to put this on the
 * left and its own buttons on the right, which left the one button that changes what the
 * campaign *does* sitting apart from the two that do less, at a smaller size. Everything that
 * can be pressed is now one group on the right, one size, with the badge alone on the left —
 * so `trailing` is where the page's own buttons go.
 */
export const CampaignStatusControl = ({
  campaignId,
  status,
  pauseReason,
  canWrite,
  trailing,
}: {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  /** Why it is paused, shown beside the badge so the next person does not have to ask. */
  readonly pauseReason?: string | null;
  readonly canWrite: boolean;
  /** The page's own buttons, placed in the same group and at the same size as the moves. */
  readonly trailing?: ReactNode;
}) => {
  const [state, dispatch, pending] = useActionState(setStatusAction, START);
  useFailureToast(state);
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
      <Row className="justify-between">
        {/* What is true, on the left. The finished note sits here rather than with the
            buttons because it describes the state, not an act. */}
        <Row>
          <Tag tone={campaignTone[status]}>{status}</Tag>
          {status === "paused" && pauseReason !== null && pauseReason !== undefined && (
            <span className="text-[12.5px] text-[var(--ink-2)]">— {pauseReason}</span>
          )}
          {canWrite && moves.length === 0 && (
            <span className="text-[12.5px] text-[var(--ink-3)]">
              This campaign is finished. Nothing more will be dialled.
            </span>
          )}
        </Row>

        {/* Everything that can be pressed, on the right and at one size. */}
        <Row>
          {canWrite &&
            moves.map((to) => (
              <Button
                key={to}
                variant={to === "running" ? "primary" : "secondary"}
                disabled={pending}
                onClick={() => (to === "paused" ? setAsking(true) : move(to))}
              >
                {moveLabel(status, to)}
              </Button>
            ))}
          {trailing}
        </Row>
      </Row>


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
