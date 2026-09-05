"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import {
  Button,
  buttonClass,
  CheckboxField,
  CheckboxGroup,
  Modal,
  Notice,
  SelectField,
  Stack,
  SubmitButton,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { createCampaignAction, type CreateCampaignState } from "../campaigns.actions";

const START: CreateCampaignState = idleForm();

/** Monday first, because a working week reads that way; the value is the API's own 0–6. */
const DAYS: readonly { readonly value: number; readonly label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

const DEFAULT_DAYS = new Set([1, 2, 3, 4, 5]);

const hourOptions = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i).map((hour) => (
    <option key={hour} value={hour}>
      {`${String(hour).padStart(2, "0")}:00`}
    </option>
  ));

export interface AgentChoice {
  readonly agentId: string;
  readonly name: string;
}

/**
 * Start a campaign, from a dialog on the list.
 *
 * An organisation with no agents cannot place calls, so there is nothing to configure: the
 * dialog says so and points at where an agent is built rather than showing a form that would
 * fail on submit. The calling window is off by default — most campaigns want the 08:00–20:00
 * WAT bound the API already applies, and the controls only appear when somebody narrows it.
 */
export const NewCampaignButton = ({ agents }: { readonly agents: readonly AgentChoice[] }) => {
  const [open, setOpen] = useState(false);
  const [windowOn, setWindowOn] = useState(false);
  const [state, action, pending] = useActionState(createCampaignAction, START);
  const errors = state.fieldErrors;
  const hasAgents = agents.length > 0;

  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New campaign
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="New campaign"
        description="An agent, and the people it should ring. It begins as a draft with nobody on it — you add contacts and start it from its own page."
        footer={
          hasAgents ? (
            <>
              <Button onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <SubmitButton
                form="new-campaign"
                pending={pending}
                idle="Create campaign"
                busy="Creating…"
              />
            </>
          ) : (
            <Button onClick={() => setOpen(false)}>Close</Button>
          )
        }
      >
        {hasAgents ? (
          <form id="new-campaign" action={action}>
            <Stack>
              <TextField
                label="Name"
                name="name"
                required
                placeholder="e.g. October arrears follow-up"
                error={errors["name"]}
              />

              <SelectField
                label="Agent"
                name="agentId"
                required
                defaultValue=""
                error={errors["agentId"]}
                hint="The agent whose script and voice these calls run."
              >
                <option value="" disabled>
                  Choose an agent
                </option>
                {agents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.name}
                  </option>
                ))}
              </SelectField>

              <CheckboxField
                label="Only call within set hours"
                name="windowEnabled"
                checked={windowOn}
                onChange={(event) => setWindowOn(event.target.checked)}
              />

              {windowOn && (
                <Stack gap="sm">
                  <div className="flex flex-wrap gap-3">
                    <SelectField
                      label="From"
                      name="startHour"
                      defaultValue={8}
                      error={errors["startHour"]}
                      className="min-w-28"
                    >
                      {hourOptions(0, 23)}
                    </SelectField>
                    <SelectField
                      label="Until"
                      name="endHour"
                      defaultValue={20}
                      error={errors["endHour"]}
                      className="min-w-28"
                    >
                      {hourOptions(1, 24)}
                    </SelectField>
                  </div>
                  <CheckboxGroup legend="Days">
                    {DAYS.map((day) => (
                      <CheckboxField
                        key={day.value}
                        label={day.label}
                        name="weekdays"
                        value={day.value}
                        defaultChecked={DEFAULT_DAYS.has(day.value)}
                      />
                    ))}
                  </CheckboxGroup>
                  {errors["weekdays"] !== undefined && (
                    <Notice tone="error">{errors["weekdays"]}</Notice>
                  )}
                  <p className="text-[12px] text-[var(--ink-3)]">
                    The window can only narrow the 08:00–20:00 WAT bound the consent rules
                    already apply. Hours are exclusive at the end — 20:00 means up to 8pm.
                  </p>
                </Stack>
              )}

              {(state.status === "failed" || state.status === "invalid") && (
                <Notice tone="error">{state.message}</Notice>
              )}
            </Stack>
          </form>
        ) : (
          <Stack>
            <Notice tone="warn">
              This organisation has no agent yet, and a campaign needs one to place its calls.
            </Notice>
            <div>
              <Link href="/agents/new" className={buttonClass("primary")}>
                Build an agent
              </Link>
            </div>
          </Stack>
        )}
      </Modal>
    </>
  );
};
