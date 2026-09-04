"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, EmptyState, Notice, Panel, Table, Tag, Td, Th, Tr } from "@/components/ui";
import { useToastStore } from "@/stores/toast.store";

import { rebuildAsFlow, rebuildAsForm } from "../agents.actions";
import type { CapturedField } from "../agents.schema";
import type { AgentSummary } from "../agents.service";
import { branchCount, questionsFromFlow } from "../flow-questions";
import { readFlow } from "../flow.schema";
import { AUTHORING_ASYMMETRY, type AuthoringMode, type FlowQuestion } from "./authoring-mode";
import { FieldBuilder } from "./field-builder";

/**
 * What this agent collects.
 *
 * The definitions are real and they save (migration 0021, `PUT /agents/:id/fields`). What
 * does not exist yet is the runtime that conducts them: nothing in the orchestrator reads
 * this array and walks a caller through it, so defining a field describes an intention
 * rather than changing a call. `FieldBuilder` says so on screen rather than leaving it to
 * be discovered on the phone.
 *
 * This is the one tab the authoring mode owns. A flow-authored agent draws its questions on
 * the canvas, so editing them here as well would give the same value two editors and no
 * answer to which one wins — the read-only view below is what it gets instead. Every other
 * tab stays editable in both modes; see `authoring-mode.tsx` for why that is not a detail.
 *
 * The cast is the counterpart of the one in the API controller. `capturedFields` crosses
 * the wire as the generated client's structural type; this feature owns the zod schema that
 * defines it, and the server validated against the same shape on the way out.
 */

/** How each confirmation setting reads in a row, which is terser than the control's wording. */
const CONFIRMED: Record<CapturedField["confirm"], { readonly label: string; readonly ok: boolean }> = {
  none: { label: "not confirmed", ok: false },
  readback: { label: "read back", ok: true },
  spellback: { label: "spelled back", ok: true },
};

const QuestionRows = ({ questions }: { readonly questions: readonly FlowQuestion[] }) => (
  <Table>
    <thead>
      <tr>
        <Th>Question</Th>
        {/* The column a list cannot have. A graph is the only thing that knows a question
            is reached on one branch and not on another, so this is what the canvas buys
            this screen. */}
        <Th>Asked</Th>
        <Th>Stored as</Th>
        <Th>Type</Th>
        <Th>Confirmed</Th>
      </tr>
    </thead>
    <tbody>
      {questions.map((question, index) => {
        const confirmed = CONFIRMED[question.confirm];
        return (
          <Tr key={`${question.key}-${index}`}>
            <Td className="max-w-[42ch]">{question.prompt === "" ? "—" : question.prompt}</Td>
            <Td>
              {question.asked === null ? (
                <span className="text-[var(--ink-3)]">always</span>
              ) : (
                <Tag tone="accent">{question.asked}</Tag>
              )}
            </Td>
            <Td className="font-mono text-[12.5px]">{question.key}</Td>
            <Td className="text-[var(--ink-3)]">{question.type}</Td>
            <Td>
              <Tag tone={confirmed.ok ? "ok" : "warn"}>{confirmed.label}</Tag>
            </Td>
          </Tr>
        );
      })}
    </tbody>
  </Table>
);

/**
 * Changing which editor an agent is built in, from the one tab the choice owns.
 *
 * Two directions, deliberately not symmetrical on screen. A form becomes a flow with one
 * press: nothing is lost, the questions are drawn as the line they already were. A flow
 * becomes a form in two presses, the second of which says how many branches it removes —
 * that is the sentence on the create screen kept, on the screen where it matters.
 */
const SwitchEditor = ({
  agentId,
  to,
  branches,
}: {
  readonly agentId: string;
  readonly to: AuthoringMode;
  /** Only meaningful going back to a form: what the flattening throws away. */
  readonly branches: number;
}) => {
  const router = useRouter();
  const show = useToastStore((store) => store.show);
  const [armed, setArmed] = useState(false);
  const [switching, startSwitching] = useTransition();

  const go = (): void => {
    startSwitching(async () => {
      const result = to === "flow" ? await rebuildAsFlow(agentId) : await rebuildAsForm(agentId);
      if (!result.ok) {
        show("error", result.message);
        return;
      }
      show(
        "ok",
        to === "flow"
          ? "Staged as a flow. Its questions are on the Flow tab; publish when it is right."
          : "Staged as a form. The questions are kept; publish when it is right.",
      );
      setArmed(false);
      router.refresh();
    });
  };

  if (to === "flow") {
    return (
      <Panel>
        <div className="flex flex-col gap-2.5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[13.5px] font-medium">Build this agent as a flow instead</p>
            <p className="mt-0.5 max-w-[60ch] text-[12.5px] text-[var(--ink-3)]">
              These questions become the first steps on a canvas, and the call can then branch
              on what the caller says. {AUTHORING_ASYMMETRY}
            </p>
          </div>
          <Button size="sm" variant="secondary" disabled={switching} onClick={go}>
            {switching ? "Rebuilding…" : "Rebuild as a flow"}
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="flex flex-col gap-2.5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[13.5px] font-medium">Turn this flow back into a form</p>
          <p className="mt-0.5 max-w-[60ch] text-[12.5px] text-[var(--ink-3)]">
            {armed
              ? branches === 0
                ? "This flow has no branches, so nothing is lost: every question is kept, in order."
                : `This removes ${branches} ${branches === 1 ? "branch" : "branches"}. Every question is kept, in the order a caller who took every branch would hear them, and the canvas stays on the agent in case you change your mind.`
              : "Every question is kept. Anything that only existed because the call could branch is not."}
          </p>
        </div>
        <span className="flex gap-2">
          {armed && (
            <Button size="sm" variant="ghost" disabled={switching} onClick={() => setArmed(false)}>
              Keep the flow
            </Button>
          )}
          <Button
            size="sm"
            variant={armed ? "danger" : "secondary"}
            disabled={switching}
            onClick={() => (armed ? go() : setArmed(true))}
          >
            {switching ? "Rebuilding…" : armed ? "Yes, make it a form" : "Turn into a form"}
          </Button>
        </span>
      </div>
    </Panel>
  );
};

const FlowQuestions = ({
  agentId,
  questions,
  branches,
}: {
  readonly agentId: string;
  readonly questions: readonly FlowQuestion[];
  readonly branches: number;
}) => {
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <h2 className="text-[17px] font-semibold tracking-[-0.018em]">What this agent collects</h2>
        <p className="mt-1 max-w-[62ch] text-[13.5px] text-[var(--ink-3)]">
          Every value the flow asks for, in the order a caller who takes every branch would
          be asked. Read-only here.
        </p>
      </div>

      <Notice tone="info">
        This agent is built as a flow, so its questions are set on the canvas rather than in
        a list. Add or change a Collect step on the canvas and it appears here.
      </Notice>

      <Panel>
        {questions.length === 0 ? (
          <EmptyState title="No questions yet">
            Nothing on the canvas collects a value. Drop a Collect step onto the Flow tab and
            it is listed here.
          </EmptyState>
        ) : (
          <QuestionRows questions={questions} />
        )}
      </Panel>

      <SwitchEditor agentId={agentId} to="form" branches={branches} />
    </div>
  );
};

export const DataCapturedTab = ({
  agent,
  authoringMode,
  flow,
}: {
  readonly agent: AgentSummary;
  /**
   * Required, with no default.
   *
   * These were optional while the agent did not carry them, defaulting to a form and to the
   * published fields — which meant a flow agent's tab quietly showed the wrong list with
   * every row reading "always", and nothing failed. The workspace has both now, and a
   * caller that forgets one is a compile error rather than a plausible screen.
   */
  readonly authoringMode: AuthoringMode;
  /** The staged graph where there is one, the published one otherwise. `unknown` off the wire. */
  readonly flow: unknown;
}) => {
  const fields = agent.capturedFields as readonly CapturedField[];

  if (authoringMode === "flow") {
    const drawn = readFlow(flow);
    /* A graph this console cannot read is the canvas's problem to explain, and it does. Here
       the honest list is the empty one — not the published fields, which may describe a
       conversation the graph no longer has. */
    const questions = drawn === null ? [] : questionsFromFlow(drawn);
    return (
      <FlowQuestions
        agentId={agent.agentId}
        questions={questions}
        branches={drawn === null ? 0 : branchCount(drawn)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <FieldBuilder agentId={agent.agentId} initial={fields} />
      <SwitchEditor agentId={agent.agentId} to="flow" branches={0} />
    </div>
  );
};
