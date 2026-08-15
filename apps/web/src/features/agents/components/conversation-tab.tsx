"use client";

import { useState, useTransition } from "react";

import {
  Notice,
  Panel,
  PanelBody,
  Row,
  SectionHead,
  SettingRow,
  Stack,
  SubmitButton,
  TextAreaField,
  TextField,
  Toggle,
} from "@/components/ui";

import { setAgentBehaviour } from "../agents.actions";
import type { AgentSummary, LiveConfiguration } from "../agents.service";

interface ConversationTabProps {
  readonly agent: AgentSummary;
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
  /** The id of the workspace form these fields belong to, so a Save button can submit it. */
  readonly publishForm: string;
  readonly publishing: boolean;
}

/**
 * Who the agent is, and how it answers.
 *
 * Two kinds of change live on this tab and they save differently, which is deliberate
 * rather than inconsistent:
 *
 *   The text — name, greeting, persona, instructions — is the script. It is versioned, so
 *   it is published, and each section has its own Save so nobody has to scroll back to the
 *   header to keep what they just wrote. The API's configuration is one atomic document,
 *   so a section Save publishes the whole of it as one version; the fields the section does
 *   not own ride along unchanged.
 *
 *   The switches are operational. They belong to the agent row rather than to the versioned
 *   document, so they save the moment they are flipped, with no note and no new version.
 *   Requiring a publish to turn barge-in off would also mean you could not turn it off
 *   without shipping whatever was half-typed in another tab.
 */

/**
 * The one switch that is not a switch.
 *
 * An irreversible tool transfers instead of executing, and that is enforced in the dispatch
 * path precisely so neither a setting nor a prompt can talk it out of it — see CLAUDE.md on
 * risk tiers. It is drawn because it is true and worth knowing, and fixed because a control
 * for disabling a safety rail should not exist.
 */
const ESCALATION = {
  title: "Transfer to a human on escalation",
  description:
    "Irreversible tools never execute — they transfer instead, and no setting changes that.",
} as const;

export const ConversationTab = ({
  agent,
  config,
  errors,
  publishForm,
  publishing,
}: ConversationTabProps) => {
  /* Held locally so the switch moves under the finger rather than after the round trip,
     and put back if the write is refused. A switch that waits for the server feels broken
     at exactly the moment somebody is deciding whether it works. */
  const [bargeIn, setBargeIn] = useState(agent.bargeIn);
  const [amd, setAmd] = useState(agent.answeringMachineDetection);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const flip = (
    change: { readonly bargeIn?: boolean; readonly answeringMachineDetection?: boolean },
    revert: () => void,
  ): void => {
    setFailure(null);
    startSaving(async () => {
      const result = await setAgentBehaviour(agent.agentId, change);
      if (!result.ok) {
        revert();
        setFailure(result.message);
      }
    });
  };

  return (
    <Stack>
      <SectionHead>Identity</SectionHead>
      <Panel>
        <PanelBody>
          <Stack>
            <TextField
              label="Agent name"
              name="name"
              defaultValue={config.name}
              maxLength={120}
              required
              error={errors["name"]}
              hint="Used when the agent introduces itself."
            />
            <TextAreaField
              label="Greeting"
              name="greeting"
              defaultValue={config.greeting ?? ""}
              maxLength={500}
              error={errors["greeting"]}
              hint="The first thing a caller hears. Leave empty to use the platform default."
            />
            <Row>
              <SubmitButton
                pending={publishing}
                idle="Save identity"
                busy="Publishing…"
                size="sm"
                form={publishForm}
              />
            </Row>
          </Stack>
        </PanelBody>
      </Panel>

      <SectionHead>How it answers</SectionHead>
      <Panel>
        <PanelBody>
          <Stack>
            <TextAreaField
              label="Persona"
              name="persona"
              defaultValue={config.persona ?? ""}
              maxLength={400}
              error={errors["persona"]}
              hint="Tone and manner, in a sentence or two. Layered onto the base prompt, never replacing it."
            />
            <TextAreaField
              label="Instructions"
              name="instructions"
              defaultValue={config.instructions ?? ""}
              maxLength={2000}
              tall
              error={errors["instructions"]}
              hint="Number and currency formatting is handled in code before anything is spoken. Asking for it here as well is a rule that holds ninety percent of the time."
            />
            <Row>
              <SubmitButton
                pending={publishing}
                idle="Save instructions"
                busy="Publishing…"
                size="sm"
                form={publishForm}
              />
            </Row>

            {failure !== null && <Notice tone="error">{failure}</Notice>}

            <div>
              <SettingRow
                title={ESCALATION.title}
                description={ESCALATION.description}
                control={<Toggle checked disabled onChange={() => undefined} label={ESCALATION.title} />}
              />
              <SettingRow
                title="Answering-machine detection"
                description="Ends an outbound call that reaches voicemail instead of talking to a greeting. Costs a second of answer latency, so it is off unless this agent dials out."
                control={
                  <Toggle
                    checked={amd}
                    disabled={saving}
                    label="Answering-machine detection"
                    onChange={(next) => {
                      setAmd(next);
                      flip({ answeringMachineDetection: next }, () => setAmd(!next));
                    }}
                  />
                }
              />
              <SettingRow
                title="Let the caller interrupt"
                description="Stops speaking the moment the caller starts. The unheard part is dropped from the agent's memory."
                control={
                  <Toggle
                    checked={bargeIn}
                    disabled={saving}
                    label="Let the caller interrupt"
                    onChange={(next) => {
                      setBargeIn(next);
                      flip({ bargeIn: next }, () => setBargeIn(!next));
                    }}
                  />
                }
              />
              <p className="mt-3 text-[12.5px] text-[var(--ink-3)]">
                Switches save as you flip them and take effect on the next call. The
                transfer rule is fixed and shown because it is worth knowing.
              </p>
            </div>

            {/* The vocabulary editor is gone; this carries what it used to write.
                `POST /config/publish` requires `keyterms`, so a form without the field
                would send an empty list and wipe the transcriber's vocabulary on the next
                publish — silently, surfacing later only as words it stopped recognising. */}
            <input type="hidden" name="keyterms" value={config.keyterms.join("\n")} />
          </Stack>
        </PanelBody>
      </Panel>
    </Stack>
  );
};
