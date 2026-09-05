"use client";

import { useActionState } from "react";

import { Button, Notice, Row, Tag } from "@/components/ui";
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
  canWrite,
}: {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly canWrite: boolean;
}) => {
  const [state, dispatch, pending] = useActionState(setStatusAction, START);
  useFormToast(state, (data) => `Campaign is now ${data.status}.`);

  const moves = nextStatuses(status);

  const move = (to: CampaignStatus) => {
    const form = new FormData();
    form.set("campaignId", campaignId);
    form.set("status", to);
    dispatch(form);
  };

  return (
    <div>
      <Row>
        <Tag tone={campaignTone[status]}>{status}</Tag>
        {canWrite &&
          moves.map((to) => (
            <Button
              key={to}
              size="sm"
              variant={to === "running" ? "primary" : "secondary"}
              disabled={pending}
              onClick={() => move(to)}
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
    </div>
  );
};
