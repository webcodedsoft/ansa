"use client";

import { startTransition, useActionState, useState } from "react";

import { Button, Card, Notice, SelectField, Stack } from "@/components/ui";
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
  const [chosen, setChosen] = useState(dialledNumber ?? "");

  return (
    <Card
      title="Number"
      description="Which of this organisation's numbers reaches this agent. Numbers are attached by the platform operator; choosing between them is yours."
    >
      {/* No `<form>`, for the same reason `VersionsTab` and `TestCallCard` have none: this
          card lives inside the workspace's one publish `<form>`, and a nested `<form>` is
          invalid HTML. The browser silently drops the inner one, React then hydrates a tree
          that differs from the server's, and every load of the workspace threw the tree away
          and rebuilt it on the client. The action is called from the button with the two
          fields it needs. */}
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

        <SelectField
          label="Answers on"
          name="dialledNumber"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
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
          <Button
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              const form = new FormData();
              form.set("agentId", agentId);
              form.set("dialledNumber", chosen);
              startTransition(() => action(form));
            }}
          >
            {pending ? "Saving…" : "Save number"}
          </Button>
        </div>
      </Stack>
    </Card>
  );
};
