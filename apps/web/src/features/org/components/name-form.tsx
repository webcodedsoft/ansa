"use client";

import { Building2 } from "lucide-react";
import { useActionState } from "react";

import { Card, Notice, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { saveName, type NameState } from "../org.actions";

const START: NameState = idleForm();

/**
 * What the organisation is called.
 *
 * Cosmetic, and only here: an agent's name is what it says on a call, and this is not that.
 * Renaming the organisation leaves every agent saying exactly what it said before.
 */
export const NameForm = ({ name }: { readonly name: string }) => {
  const [state, action, pending] = useActionState(saveName, START);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Building2 aria-hidden className="size-4 text-[var(--ink-3)]" />
          General
        </span>
      }
      description="What this organisation is called in the console. Each agent introduces itself in its own words, set on the agent."
    >
      <form action={action} className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && <Notice tone="ok">{state.message}</Notice>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField label="Name" name="name" defaultValue={name} required />
          <TextField
            label="Time zone"
            name="timeZone"
            value="Africa/Lagos (WAT, UTC+1)"
            readOnly
            hint="Hours and calling windows are in this zone. Ansa runs in West Africa Time."
          />
        </div>
        <div>
          <SubmitButton pending={pending} idle="Save" />
        </div>
      </form>
    </Card>
  );
};
