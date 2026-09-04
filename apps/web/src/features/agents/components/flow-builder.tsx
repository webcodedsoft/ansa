"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useActionState, useState } from "react";

import { Button, Modal, Notice, SubmitButton, Tag, TextAreaField, buttonClass } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { useFormToast } from "@/stores/toast.store";

import {
  publishFlowAction,
  saveFlowAction,
  type PublishState,
  type SaveFlowState,
} from "../agents.actions";
import type { AgentSummary } from "../agents.service";
import { FlowCanvas } from "./flow-canvas";

/** One form on the page, so the canvas has an id to write into and Save and Publish share it. */
const FLOW_FORM = "flow-builder";

/**
 * The flow builder page: the canvas, and the two things it can do to what is drawn.
 *
 * Save stages the drawing. Publish stages it and then publishes everything staged, as one
 * version, with a note — the same act the workspace's Publish performs, reached from here so
 * that somebody who has just finished drawing does not have to go back to a tab to make it
 * live. Nothing else about the agent is edited here; that is what the workspace is for, and
 * the way back to it is the first thing in the header.
 */
export const FlowBuilder = ({
  agent,
  flow,
  authoringMode,
  hasUnpublishedGraph,
}: {
  readonly agent: AgentSummary;
  /** The draft's graph where there is one, the published one otherwise. `unknown` off the wire. */
  readonly flow: unknown;
  readonly authoringMode: "form" | "flow";
  readonly hasUnpublishedGraph: boolean;
}) => {
  const [saveState, save, saving] = useActionState<SaveFlowState, FormData>(saveFlowAction, idleForm());
  const [publishState, publish, publishing] = useActionState<PublishState, FormData>(
    publishFlowAction,
    idleForm(),
  );
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [blocking, setBlocking] = useState(0);

  useFormToast(saveState, () => "Saved. Nothing is live until you publish.");
  useFormToast(publishState, (data) => `Published version ${data.version}.`);

  const failure =
    publishState.status === "failed" || publishState.status === "invalid"
      ? publishState.message
      : saveState.status === "failed"
        ? saveState.message
        : null;

  return (
    <div className="flex flex-col gap-3.5">
      <header className="flex flex-wrap items-center gap-3">
        <Link href={`/agents/${agent.agentId}`} className={buttonClass("ghost", "sm")}>
          <ArrowLeft className="size-3.5" />
          {agent.name}
        </Link>
        <h1 className="text-[17px] font-semibold tracking-[-0.018em]">Flow</h1>
        <Tag tone={authoringMode === "flow" ? "accent" : "neutral"}>
          {authoringMode === "flow" ? "conducts the call" : "not in use — the agent runs as a form"}
        </Tag>
        {hasUnpublishedGraph && <Tag tone="warn">unpublished changes</Tag>}
        <span className="flex-1" />
        <SubmitButton pending={saving} idle="Save" busy="Saving…" variant="secondary" form={FLOW_FORM} formAction={save} />
        <Button
          variant="primary"
          disabled={saving || publishing || blocking > 0}
          title={blocking > 0 ? `${blocking === 1 ? "A problem" : `${blocking} problems`} below must be fixed first.` : undefined}
          onClick={() => setAsking(true)}
        >
          {publishing ? "Publishing…" : blocking > 0 ? `Fix ${blocking} first` : "Publish"}
        </Button>
      </header>

      {failure !== null && <Notice tone="error">{failure}</Notice>}

      {authoringMode === "form" && (
        <Notice tone="info">
          This agent runs as a form, so what is drawn here is kept but does not conduct calls.
          To switch it onto the flow, open the Data captured tab on the agent and choose
          &ldquo;Rebuild as a flow&rdquo;.
        </Notice>
      )}

      {/* The form the canvas writes into. `agentId` is what the actions read the agent from —
          a server action has no route to read it off. */}
      <form id={FLOW_FORM} action={save}>
        <input type="hidden" name="agentId" value={agent.agentId} />
      </form>

      <FlowCanvas flow={flow} publishForm={FLOW_FORM} authoringMode={authoringMode} onBlockingProblems={setBlocking} />

      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Publish this flow"
        description="The flow goes live together with anything else staged on this agent, as one version. Say what changed so the history means something to whoever reads it next."
        footer={
          <>
            <Button onClick={() => setAsking(false)} disabled={publishing}>
              Cancel
            </Button>
            <SubmitButton pending={publishing} idle="Publish" busy="Publishing…" form={FLOW_FORM} formAction={publish} />
          </>
        }
      >
        <TextAreaField
          autoFocus
          required
          label="What changed"
          name="note"
          form={FLOW_FORM}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          error={note.trim() === "" && publishState.status === "invalid" ? publishState.fieldErrors["note"] : undefined}
        />
      </Modal>
    </div>
  );
};
