"use client";

import { useActionState, useState } from "react";

import { Notice, SubmitButton } from "@/components/ui";
import type { ToolsDocument } from "@/features/agents/agents.service";
import { FlowCanvas } from "@/features/agents/components/flow-canvas";
import { registryTools } from "@/features/agents/components/tools-tab";
import { idleForm } from "@/lib/form-state";
import { useFormToast, useFailureToast } from "@/stores/toast.store";

import { saveCampaignFlowAction, type BriefState } from "../campaigns.actions";

const START: BriefState = idleForm();
const FORM = "campaign-flow";

/**
 * The conversation this campaign has, drawn on the same canvas an agent's flow uses.
 *
 * The same builder rather than a second one, because it is the same problem: a call that asks
 * questions, branches on the answers, confirms what it heard and ends somewhere. A campaign
 * differs in why the phone rang, not in how a conversation is shaped, and a second editor
 * would be a second set of bugs in the same graph.
 *
 * It is optional, and that is deliberate. A campaign whose purpose is "to confirm your viewing
 * on Tuesday" needs no graph: the agent says why it rang, listens, records an outcome and
 * finishes. A graph earns its place when the call has to collect something — a new date, a
 * reason for declining — and until then an empty canvas is an honest answer.
 *
 * Frozen once the campaign runs, like the rest of the brief. The canvas is still drawn so a
 * person can read what the calls are doing; it simply cannot be saved.
 *
 * An unfinished drawing does not save at all — the canvas withholds its hidden field until the
 * graph holds together, which is the rule it already follows on an agent. The API is more
 * permissive and checks at Start instead, so the two are not in conflict: the console refuses
 * earlier than it has to, which is the right direction for the half a person is looking at.
 */
export const CampaignConversation = ({
  campaignId,
  flow,
  editable,
  canWrite,
  tools,
  transferNumber,
}: {
  readonly campaignId: string;
  readonly flow: unknown;
  readonly editable: boolean;
  readonly canWrite: boolean;
  /**
   * The organisation's tool registry, flattened here rather than by the page.
   *
   * `registryTools` lives in a client module, so a server component cannot call it — the page
   * hands over the document and this does the mapping. Everything is marked enabled: enabling
   * is the agent's setting, and a campaign step names a tool the agent already has rather than
   * granting one.
   */
  readonly tools: ToolsDocument;
  readonly transferNumber: string | null;
}) => {
  const [state, action, pending] = useActionState(saveCampaignFlowAction, START);
  useFailureToast(state);
  const [blocking, setBlocking] = useState(0);
  const [dirty, setDirty] = useState(false);
  useFormToast(state, () => "Conversation saved.");

  const disabled = !editable || !canWrite;
  const available = registryTools(tools).map((tool) => ({ name: tool.name, enabled: true }));

  return (
    /* No card around the canvas. It draws its own three panels — the palette, the drawing
       and the step editor — and a titled frame around all three was a fourth box saying
       "the conversation" above a thing that plainly is one. The notices sit above it bare,
       as they do on the agent workspace. */
    <div className="flex flex-col gap-3.5">
      {!editable && (
        <Notice tone="info">
          This campaign has started, so its conversation is fixed. It is shown here to read.
        </Notice>
      )}


      {blocking > 0 && (
        <Notice tone="warn">
          {blocking === 1
            ? "One problem below has to be fixed before this drawing can be saved."
            : `${blocking} problems below have to be fixed before this drawing can be saved.`}{" "}
          The canvas withholds an unfinished graph rather than storing one that would stop a
          call mid sentence — the same rule it follows on an agent. Starting the campaign
          checks it again.
        </Notice>
      )}

      <form id={FORM} action={action}>
        <input type="hidden" name="campaignId" value={campaignId} />
      </form>

      <FlowCanvas
        flow={flow}
        publishForm={FORM}
        /* Always `flow`: a campaign has no form mode to fall back to, and its graph is the
           conversation whenever there is one. */
        authoringMode="flow"
        onBlockingProblems={setBlocking}
        onEdited={() => setDirty(true)}
        availableTools={available}
        transferNumber={transferNumber}
        /* A campaign has no settings panels of its own — the voice, the manner and the tools
           belong to the agent it uses, which is edited on the agent. */
        onOpenSettings={() => undefined}
      />

      {!disabled && dirty && (
        /* Hidden rather than disabled until something changes: a button that does nothing
           invites the press that finds that out. */
        <div>
          <SubmitButton form={FORM} pending={pending} idle="Save conversation" />
        </div>
      )}
    </div>
  );
};
