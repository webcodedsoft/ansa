"use client";

import Link from "next/link";
import { startTransition, useActionState, useState } from "react";

import { Button, Card, Notice, SelectField, Stack } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { setDiary, type DiaryState } from "../agents.actions";

const START: DiaryState = idleForm();

export interface PickableCalendar {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

/**
 * Which diary this agent can book a caller into.
 *
 * Setting this is what gives a call the two booking tools — one to read out what is free,
 * one to take a time. Without it the agent is never told it can offer an appointment at
 * all, which is deliberate: a model that can see a tool will offer it, and "let me book you
 * in" followed by a refusal is worse than never raising it.
 *
 * Applied immediately, not staged, exactly as routing is and for the same reason. It changes
 * nothing a caller hears, so there is no configuration version for it to wait in.
 */
export const DiaryCard = ({
  agentId,
  appointmentCalendarId,
  calendars,
}: {
  readonly agentId: string;
  readonly appointmentCalendarId: string | null;
  readonly calendars: readonly PickableCalendar[];
}) => {
  const [state, action, pending] = useActionState(setDiary, START);
  const [chosen, setChosen] = useState(appointmentCalendarId ?? "");

  const nameOf = (id: string): string => calendars.find((c) => c.id === id)?.name ?? "that calendar";

  return (
    <Card
      title="Diary"
      description="Which calendar this agent books callers into. Its opening hours, slot length and buffer decide what a caller is offered."
    >
      {/* No `<form>`: this card sits inside the workspace's one publish form, and a nested
          form is invalid HTML — see the note in RoutingCard for what that cost. */}
      <Stack>
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && state.data !== null && (
          <Notice tone="ok">
            {state.data.appointmentCalendarId === null
              ? "Saved. This agent no longer offers appointments."
              : `Saved. This agent books into ${nameOf(state.data.appointmentCalendarId)} from the next call.`}
          </Notice>
        )}

        {calendars.length === 0 && (
          <Notice tone="warn">
            This organisation has no calendars yet, so there is nothing to book into. Make one
            on <Link href="/appointments" className="underline">the appointments page</Link>{" "}
            first.
          </Notice>
        )}

        <SelectField
          label="Books into"
          name="appointmentCalendarId"
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          <option value="">No diary — this agent does not take appointments</option>
          {calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>
              {calendar.name} — {calendar.timezone}
            </option>
          ))}
        </SelectField>

        <div>
          <Button pending={pending}
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            onClick={() => {
              const form = new FormData();
              form.set("agentId", agentId);
              form.set("appointmentCalendarId", chosen);
              startTransition(() => action(form));
            }}
          >
            "Save diary"
          </Button>
        </div>
      </Stack>
    </Card>
  );
};
