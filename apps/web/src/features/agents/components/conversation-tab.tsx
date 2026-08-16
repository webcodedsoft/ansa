"use client";

import { useState, useTransition } from "react";

import {
  Notice,
  Panel,
  PanelBody,
  SectionHead,
  SettingRow,
  Stack,
  TextAreaField,
  TextField,
  Toggle,
} from "@/components/ui";

import { setAgentBehaviour } from "../agents.actions";
import type { AgentSummary, LiveConfiguration } from "../agents.service";
import { SaveBar } from "./save-bar";

interface ConversationTabProps {
  readonly agent: AgentSummary;
  readonly config: LiveConfiguration["config"];
  readonly errors: Readonly<Record<string, string>>;
  readonly publishForm: string;
  readonly savingDraft: boolean;
  /** The id of the workspace form these fields belong to, so a Save button can submit it. */
}

/**
 * Who the agent is, and how it answers.
 *
 * Two kinds of change live on this tab and they are entered differently, though since 0041
 * they end in the same place:
 *
 *   The text — name, greeting, persona, instructions — is the script. It is part of the
 *   configuration document, so it is saved into the draft by this tab's Save and goes live
 *   when somebody publishes.
 *
 *   The switches are entered one at a time, with no Save button: flipping one stages it by
 *   itself. They used to write the agent row directly, on the argument that a switch is an
 *   operational control rather than a script change — but a caller cannot hear the
 *   difference, and one of the two ways an agent's behaviour changed was leaving no trace in
 *   any version. They now stage like everything else the agent owns, and the switch shows
 *   the staged value where there is one.
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
  savingDraft,
}: ConversationTabProps) => {
  /* Held locally so the switch moves under the finger rather than after the round trip,
     and put back if the write is refused. A switch that waits for the server feels broken
     at exactly the moment somebody is deciding whether it works. Seeded from the staged
     agent, so a flip saved earlier and not yet published still reads as flipped. */
  const [bargeIn, setBargeIn] = useState(agent.bargeIn);
  const [amd, setAmd] = useState(agent.answeringMachineDetection);

  /**
   * Take the server's answer when it differs from the one this panel was seeded with.
   *
   * `useState` seeds once, so the switches held their optimistic value forever: discarding a
   * draft removed the staged flag, the page refreshed with the live value, and the switch
   * carried on showing the flip that had just been thrown away. Every other field in the
   * workspace resets by remounting, but the panel's key is the configuration document — and
   * it has to be, or flipping a switch would remount the panel and throw away text somebody
   * had typed beside it and not yet saved. Two kinds of state on one panel, resetting on
   * different conditions.
   *
   * Adjusted during render rather than in an effect, which is the documented way to reset
   * state when a prop changes: an effect would paint the stale value first, and the answer
   * can arrive after somebody has already flipped the switch again.
   */
  const [seeded, setSeeded] = useState({
    bargeIn: agent.bargeIn,
    amd: agent.answeringMachineDetection,
  });
  if (seeded.bargeIn !== agent.bargeIn || seeded.amd !== agent.answeringMachineDetection) {
    setSeeded({ bargeIn: agent.bargeIn, amd: agent.answeringMachineDetection });
    setBargeIn(agent.bargeIn);
    setAmd(agent.answeringMachineDetection);
  }
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
            <SaveBar pending={savingDraft} form={publishForm} />
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
                Switches save as you flip them and take effect when you publish, like
                everything else on this page. The transfer rule is fixed and shown because it
                is worth knowing.
              </p>
            </div>

            {/* The vocabulary editor is gone; this carries what it used to write.
                `POST /config/publish` requires `keyterms`, so a form without the field
                would send an empty list and wipe the transcriber's vocabulary on the next
                publish — silently, surfacing later only as words it stopped recognising. */}
            <input type="hidden" name="keyterms" value={config.keyterms.join("\n")} />
            <SaveBar pending={savingDraft} form={publishForm} />
          </Stack>
        </PanelBody>
      </Panel>
    </Stack>
  );
};
