"use client";

import { Button, EmptyState, Notice, Panel, Table, Tag, Td, Th, Tr, useOpenTab } from "@/components/ui";

import type { CapturedField } from "../agents.schema";
import type { AgentSummary } from "../agents.service";
import {
  DEFAULT_AUTHORING_MODE,
  FLOW_TAB_ID,
  questionsFromFields,
  type AuthoringMode,
  type FlowQuestion,
} from "./authoring-mode";
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

const FlowQuestions = ({ questions }: { readonly questions: readonly FlowQuestion[] }) => {
  const openTab = useOpenTab();

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
        a list. Add or change a Collect step on the Flow tab and it appears here.
        <span className="mt-2 block">
          {/* Not an `<a>`: the tabs switch panels in place and never navigate, so there is no
              URL for this to be. `useOpenTab` reaches the tab strip's own state by id. */}
          <Button size="sm" onClick={() => openTab(FLOW_TAB_ID)}>
            Open the Flow tab
          </Button>
        </span>
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
    </div>
  );
};

export const DataCapturedTab = ({
  agent,
  authoringMode = DEFAULT_AUTHORING_MODE,
  questions,
}: {
  readonly agent: AgentSummary;
  /**
   * Optional, defaulting to a form, because the agent does not carry it yet.
   *
   * `authoringMode` is being added to the database and the API in parallel; until it
   * reaches the generated client every agent reads as form-authored, which is what every
   * agent created so far actually is.
   */
  readonly authoringMode?: AuthoringMode;
  /**
   * The questions the graph produces, when something can compile the graph into them.
   *
   * The canvas is not persisted yet, so nothing can. Without it this falls back to the
   * agent's published fields, which is the same list a flow that never branches would
   * produce — every row reading "always" until the branches are real.
   */
  readonly questions?: readonly FlowQuestion[];
}) => {
  const fields = agent.capturedFields as readonly CapturedField[];

  if (authoringMode === "flow") {
    return <FlowQuestions questions={questions ?? questionsFromFields(fields)} />;
  }

  return <FieldBuilder agentId={agent.agentId} initial={fields} />;
};
