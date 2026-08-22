"use client";

import { useActionState } from "react";

import { Card, Notice, SelectField, Stack, SubmitButton } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { setRouting, type RoutingState } from "../agents.actions";

const START: RoutingState = idleForm();

export interface HeldNumber {
  readonly number: string;
  readonly answeredBy: { readonly agentId: string; readonly name: string } | null;
}

/**
 * Which of the organisation's numbers reaches this agent.
 *
 * Routing is the agent's and ownership is not, which is the split migration 0019 exists for.
 * An organisation chooses which of its own agents answers a line it already holds; it cannot
 * add a line, because `organization_numbers` is written by an operator and `ansa_app` holds
 * SELECT on it and nothing else. An organisation that could claim a number would be claiming
 * one somebody else controls at their carrier, and the damage lands on whoever is onboarded
 * onto it next.
 *
 * A number another agent answers is shown and disabled rather than hidden. "Answered by
 * Support" is the answer somebody is looking for, and omitting it makes a number they know
 * they own look as though it vanished.
 *
 * Applied immediately, not staged. Routing has never been part of a configuration version, so
 * there is nothing to stage it into — the same reasoning as the organisation's hours.
 */
export const RoutingCard = ({
  agentId,
  dialledNumber,
  held,
}: {
  readonly agentId: string;
  readonly dialledNumber: string | null;
  readonly held: readonly HeldNumber[];
}) => {
  const [state, action, pending] = useActionState(setRouting, START);

  return (
    <Card
      title="Number"
      description="Which of this organisation's numbers reaches this agent. Numbers are attached by the platform operator; choosing between them is yours."
    >
      <form action={action}>
        <Stack>
          {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
          {state.status === "succeeded" && state.data !== null && (
            <Notice tone="ok">
              {state.data.dialledNumber === null
                ? "Unrouted. No caller reaches this agent until it has a number."
                : `Saved. ${state.data.dialledNumber} reaches this agent now.`}
            </Notice>
          )}

          {held.length === 0 && (
            <Notice tone="warn">
              This organisation holds no numbers yet, so there is nothing to route. Ask whoever
              runs the platform to attach one.
            </Notice>
          )}

          <input type="hidden" name="agentId" value={agentId} />

          <SelectField label="Answers on" name="dialledNumber" defaultValue={dialledNumber ?? ""}>
            <option value="">Not routed — no caller reaches this agent</option>
            {held.map((entry) => {
              const takenByAnother =
                entry.answeredBy !== null && entry.answeredBy.agentId !== agentId;
              return (
                <option key={entry.number} value={entry.number} disabled={takenByAnother}>
                  {entry.number}
                  {takenByAnother
                    ? ` — answered by ${entry.answeredBy?.name ?? "another agent"}`
                    : ""}
                </option>
              );
            })}
          </SelectField>

          <div>
            <SubmitButton pending={pending} idle="Save number" busy="Saving…" variant="primary" />
          </div>
        </Stack>
      </form>
    </Card>
  );
};
