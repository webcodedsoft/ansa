import { Card, CheckboxField, CheckboxGroup, FieldError, NumberField, Notice, Stack, Td, TextField } from "@/components/ui";

import type { LiveConfiguration } from "../agents.service";
import { SaveBar } from "./save-bar";

const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

const DEFAULT_OPEN_DAYS: readonly number[] = [1, 2, 3, 4, 5];

interface RoutingTabProps {
  readonly config: LiveConfiguration["config"];
  readonly operatorManaged: LiveConfiguration["operatorManaged"];
  readonly errors: Readonly<Record<string, string>>;
  readonly publishForm: string;
  readonly savingDraft: boolean;
}

/** When the organisation counts as open, where a call hands over, and what the operator controls. */
export const RoutingTab = ({ config, operatorManaged, errors, publishForm, savingDraft }: RoutingTabProps) => {
  const hours = config.businessHours;
  const escalation = config.escalation;
  const openDays = hours?.openDays ?? DEFAULT_OPEN_DAYS;
  const { consent } = operatorManaged;
  const callingHours =
    consent.callingEarliestHour === null || consent.callingLatestHour === null
      ? "not restricted"
      : `${consent.callingEarliestHour}:00 to ${consent.callingLatestHour}:00`;

  return (
    <Stack>
      {/*
        Named for the organisation, not for the agent, because that is where they are stored.
        `publish_agent_config` writes `business_open_hour`, `business_close_hour` and
        `business_days` onto `organizations` — so these hours are shared, and publishing them
        from one agent's workspace moves them for every agent the organisation has.

        Indistinguishable from a per-agent setting today, since no organisation has a second
        live agent and migration 0047 refuses to resolve one if they do. It stops being
        indistinguishable the moment that changes, and the failure would be silent: an
        operator sets Saturday hours on the agent they have open and quietly opens the other
        one too. Saying so costs a sentence; whether hours should become per-agent is a
        product decision, and one this label does not pre-empt.
      */}
      <Card
        title="Business hours"
        description="When the organisation counts as open. Shared by every agent it runs, so publishing here changes them all. Unchecked means always open."
      >
        <Stack>
          <CheckboxField label="Restrict to set hours" name="hoursEnabled" defaultChecked={hours !== null} />

          <div className="grid gap-3.5 sm:grid-cols-2">
            <NumberField label="Opens at" name="opensAtHour" min={0} max={23} defaultValue={hours?.opensAtHour ?? 9} error={errors["opensAtHour"]} />
            <NumberField label="Closes at" name="closesAtHour" min={1} max={24} defaultValue={hours?.closesAtHour ?? 17} error={errors["closesAtHour"]} />
          </div>

          <div>
            <CheckboxGroup legend="Open days">
              {DAYS.map((day) => (
                <CheckboxField key={day.value} label={day.label} name="openDays" value={day.value} defaultChecked={openDays.includes(day.value)} />
              ))}
            </CheckboxGroup>
            {errors["openDays"] !== undefined && <FieldError>{errors["openDays"]}</FieldError>}
          </div>
        </Stack>
      </Card>

      <Card title="Escalation" description="Where a call goes when the agent hands over to a person.">
        <Stack>
          <CheckboxField label="Transfer to a human" name="escalationEnabled" defaultChecked={escalation !== null} />

          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField label="Transfer to" name="toNumber" defaultValue={escalation?.toNumber ?? ""} placeholder="+2348000000000" error={errors["toNumber"]} />
            <TextField label="Calling from" name="fromNumber" defaultValue={escalation?.fromNumber ?? ""} placeholder="+2348000000000" error={errors["fromNumber"]} />
          </div>

          <NumberField
            label="Ring for"
            name="ringSeconds"
            min={5}
            max={120}
            defaultValue={escalation?.ringSeconds ?? ""}
            className="max-w-50"
            error={errors["ringSeconds"]}
            hint="Seconds. Empty uses the default."
          />

          <Notice tone="warn">Irreversible tools never execute. They transfer here instead, and no configuration changes that.</Notice>

          {/* On the last editable card rather than on each: the two above it are one setting
              apiece, and a save bar under every one of them would outnumber the fields. */}
          <SaveBar pending={savingDraft} form={publishForm} />
        </Stack>
      </Card>

      <Card title="Set by the operator" description="Not editable here. Ask whoever runs the platform to change these.">
        <table className="w-full border-collapse text-sm">
          <tbody>
            <tr>
              <Td className="text-[var(--ink-3)]">Number</Td>
              <Td className="font-mono text-[13px]">{operatorManaged.dialledNumber ?? "not assigned"}</Td>
            </tr>
            <tr>
              <Td className="text-[var(--ink-3)]">Audio retention</Td>
              <Td>{operatorManaged.audioRetentionDays} days</Td>
            </tr>
            <tr>
              <Td className="text-[var(--ink-3)]">Consent policy</Td>
              <Td>
                {consent.policy}
                {consent.basis === null ? "" : ` · ${consent.basis}`}
              </Td>
            </tr>
            <tr>
              <Td className="border-b-0 text-[var(--ink-3)]">Calling hours</Td>
              <Td className="border-b-0">{callingHours}</Td>
            </tr>
          </tbody>
        </table>
      </Card>
    </Stack>
  );
};
