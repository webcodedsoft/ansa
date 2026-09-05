import Link from "next/link";

import { Card, CheckboxField, Notice, NumberField, Stack, Td, TextField } from "@/components/ui";

import type { LiveConfiguration } from "../agents.service";
import { RoutingCard, type HeldNumber } from "./routing-card";
import { SaveBar } from "./save-bar";

interface RoutingTabProps {
  readonly agentId: string;
  /** Every number the organisation holds, so the picker can show what is taken and by whom. */
  readonly held: readonly HeldNumber[];
  readonly config: LiveConfiguration["config"];
  readonly operatorManaged: LiveConfiguration["operatorManaged"];
  readonly errors: Readonly<Record<string, string>>;
  readonly publishForm: string;
  readonly savingDraft: boolean;
}

/** When the organisation counts as open, where a call hands over, and what the operator controls. */
export const RoutingTab = ({ agentId, held, config, operatorManaged, errors, publishForm, savingDraft }: RoutingTabProps) => {
  const escalation = config.escalation;
  const { consent } = operatorManaged;
  const callingHours =
    consent.callingEarliestHour === null || consent.callingLatestHour === null
      ? "not restricted"
      : `${consent.callingEarliestHour}:00 to ${consent.callingLatestHour}:00`;

  return (
    <Stack>
      {/*
        The hours card used to live here and does not any more.

        It was editing the organisation's opening hours from inside one agent's workspace, and
        publishing that agent wrote all three columns. With two agents that is one agent's form
        silently moving every other agent's opening times — the same shape of bug 0047 and 0052
        closed elsewhere. Hours were never in a configuration version either: the snapshot has
        no columns for them, so a diff always said "unchanged" and a rollback could never
        restore one. Migration 0053 moved them out of the publish document entirely and onto
        `PUT /organization/hours`, which applies immediately because there is no version for
        them to wait for.
      */}
      <Notice tone="ok">
        Opening hours are the organisation&apos;s and are shared by every agent it runs, so they
        are set on <Link href="/organisation" className="underline">the organisation page</Link>{" "}
        rather than here. Changing them there takes effect on the next call — there is no
        version to publish.
      </Notice>

      <RoutingCard
        agentId={agentId}
        dialledNumber={operatorManaged.dialledNumber}
        held={held}
      />

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
            {/* The number moved to its own card above. Which numbers this organisation holds
                is the operator's; which agent answers one of them is not, and showing it here
                said the opposite. */}
            <tr>
              <Td className="text-[var(--ink-3)]">Audio retention</Td>
              <Td>{operatorManaged.audioRetentionDays} days</Td>
            </tr>
            {/* Two windows, not one, and worth showing separately: the recording of somebody
                reading a reference number aloud is deleted on the first clock, the
                transcript of them reading it on the second. The words are kept longer on
                purpose — the review loop corrects transcripts and the eval corpus is built
                from those corrections — and a reader who saw only the audio number would
                believe everything was gone a month after the call. */}
            <tr>
              <Td className="text-[var(--ink-3)]">Transcript retention</Td>
              <Td>{operatorManaged.transcriptRetentionDays} days</Td>
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
