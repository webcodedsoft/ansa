"use client";

import { Building2 } from "lucide-react";
import { useActionState } from "react";

import { Button, Card, Notice, SubmitButton, TextField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { saveDetails, type DetailsState } from "../org.actions";
import type { Organisation } from "../org.service";

const START: DetailsState = idleForm();

/**
 * What the organisation says about itself.
 *
 * Cosmetic, and only here: an agent's name is what it says on a call, and this is not that.
 * Renaming the organisation leaves every agent saying exactly what it said before. The
 * email and website are kept for the people who run the company; the agent does not read
 * them out, and the hints say so rather than implying a caller will hear them.
 */
export const DetailsForm = ({ organisation }: { readonly organisation: Organisation }) => {
  const [state, action, pending] = useActionState(saveDetails, START);
  const errors = state.fieldErrors;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Building2 aria-hidden className="size-4 text-[var(--ink-3)]" />
          General
        </span>
      }
      description="What this organisation is called and where it can be written to. Each agent introduces itself in its own words, set on the agent."
    >
      <form action={action} className="flex flex-col gap-4">
        {state.status === "failed" && <Notice tone="error">{state.message}</Notice>}
        {state.status === "succeeded" && <Notice tone="ok">{state.message}</Notice>}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Name"
            name="name"
            defaultValue={organisation.name}
            required
            error={errors["name"]}
          />
          <TextField
            label="Time zone"
            name="timeZone"
            value="Africa/Lagos (WAT, UTC+1)"
            readOnly
            hint="Hours and calling windows are in this zone. Ansa runs in West Africa Time."
          />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <TextField
            label="Support email"
            name="supportEmail"
            type="email"
            inputMode="email"
            autoComplete="off"
            defaultValue={organisation.supportEmail ?? ""}
            placeholder="hello@example.com"
            error={errors["supportEmail"]}
            hint="For the people who run this organisation. The agent does not read it out — an address spoken down a phone line is not one a caller can write down."
          />
          <TextField
            label="Website"
            name="website"
            inputMode="url"
            autoComplete="off"
            defaultValue={organisation.website ?? ""}
            placeholder="example.com"
            error={errors["website"]}
            hint="Kept with the organisation's record. Not read out on calls."
          />
        </div>
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium">How the agent introduces you</div>
          <p className="m-0 rounded-lg border border-dashed border-[var(--hairline)] px-3.5 py-3 text-[13.5px] text-[var(--ink-2)] italic">
            &ldquo;Thank you for calling {organisation.name}.
            {organisation.recordCalls ? " This call is recorded." : ""} How can I help you?&rdquo;
          </p>
          <p className="mt-1.5 mb-0 text-[12px] text-[var(--ink-3)]">
            Built from the name above; the rest of the greeting is set per agent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SubmitButton pending={pending} idle="Save" />
          <Button type="reset" variant="ghost">
            Reset
          </Button>
        </div>
      </form>
    </Card>
  );
};
