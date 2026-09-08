"use client";

import { useActionState, useState } from "react";

import { Button, Card, Tag } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { suppressContactAction } from "../contacts.actions";
import type { ContactDetail } from "../contacts.service";

/**
 * Whether this person may lawfully be rung, and the one control that changes the answer.
 *
 * The verdict is not computed here. It arrives already decided by `mayCall` — the same pure
 * function `placeOutboundCall` gates on — so this panel cannot drift from what the dispatch
 * path would actually do. That matters more than it sounds: the failure mode of a second
 * implementation is a screen saying "may call" over a number that gets refused, and the person
 * reading it believes the screen and goes looking for a bug in the dialler.
 *
 * It is a snapshot, and it says so. Calling hours mean the answer flips at 08:00 and again at
 * 20:00 with nothing edited, so the panel states that the check runs again on every call
 * whatever this says. Read as permission it would be wrong twice a day; read as an explanation
 * it is right.
 *
 * Suppression is one-way from here. There is no endpoint that lifts one, which is deliberate:
 * "stop calling me" is the most explicit thing a person can say, and a control that could
 * quietly undo it is a control that will. So this asks first.
 */
export const ContactConsent = ({
  contactId,
  consent,
}: {
  readonly contactId: string;
  readonly consent: ContactDetail["consent"];
}) => {
  const [state, submit, pending] = useActionState(suppressContactAction, idleForm<null>());
  const [confirming, setConfirming] = useState(false);

  /* The policy is the organisation's own words for why it may ring anybody at all. It sits
     beside the verdict rather than instead of it, because "existing relationship" is the
     reason a call is allowed and the verdict is whether it is allowed right now. */
  const policyLabel =
    consent.policy === "existing_relationship" ? "existing relationship" : "consent per number";

  const hours =
    consent.earliestHour === null || consent.latestHour === null
      ? "Hours 08:00–20:00 WAT."
      : `Hours ${String(consent.earliestHour).padStart(2, "0")}:00–${String(consent.latestHour).padStart(2, "0")}:00 WAT.`;

  const settled = state.status === "succeeded" || consent.suppressed;

  return (
    <Card title="Whether we may ring" description="What the dispatch path would decide right now.">
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              consent.allowed
                ? "inline-flex items-center rounded-[4px] border border-[color-mix(in_srgb,var(--ok)_34%,transparent)] bg-[color-mix(in_srgb,var(--ok)_12%,transparent)] px-2 py-0.5 text-[12px] font-medium text-[var(--ok)]"
                : "inline-flex items-center rounded-[4px] border border-[color-mix(in_srgb,var(--bad)_34%,transparent)] bg-[color-mix(in_srgb,var(--bad)_12%,transparent)] px-2 py-0.5 text-[12px] font-medium text-[var(--bad)]"
            }
          >
            {consent.allowed ? "may call" : "may not call"}
          </span>
          <Tag>{policyLabel}</Tag>
          {consent.suppressed && <Tag>on the do-not-call list</Tag>}
        </div>

        {/* The gate's own sentence, not a paraphrase. "outside calling hours (21:00 WAT,
            allowed 8-19)" tells somebody when to try again; "cannot call" does not. */}
        {consent.reason !== null && (
          <p className="m-0 text-[12.5px] leading-relaxed text-[var(--ink-2)]">{consent.reason}.</p>
        )}

        <p className="m-0 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
          {consent.suppressed ? "On the do-not-call list. " : "Not on the do-not-call list. "}
          {hours} Checked again on every call, whatever this says.
        </p>

        {consent.basis !== null && consent.basis.trim() !== "" && (
          <p className="m-0 border-t border-[var(--surface-line)] pt-2.5 text-[11.5px] leading-relaxed text-[var(--ink-3)]">
            {consent.basis}
          </p>
        )}

        {settled ? (
          state.status === "succeeded" && (
            <p className="m-0 text-[12px] text-[var(--ok)]">{state.message}</p>
          )
        ) : (
          <form action={submit} className="border-t border-[var(--surface-line)] pt-2.5">
            <input type="hidden" name="contactId" value={contactId} />
            <input type="hidden" name="reason" value="Added from the contact page" />
            {confirming ? (
              <div className="flex flex-col gap-2">
                <p className="m-0 text-[12px] leading-relaxed text-[var(--ink-2)]">
                  This holds everywhere and for good — no screen here lifts it again.
                </p>
                <div className="flex items-center gap-2">
                  <Button type="submit" variant="primary" disabled={pending}>
                    {pending ? "Adding…" : "Yes, never ring this number"}
                  </Button>
                  <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
                Add to do-not-call
              </Button>
            )}
            {state.status === "failed" && (
              <p className="mt-2 mb-0 text-[12px] text-[var(--bad)]">{state.message}</p>
            )}
          </form>
        )}
      </div>
    </Card>
  );
};
