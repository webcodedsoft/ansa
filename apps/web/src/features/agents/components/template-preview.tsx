"use client";

import { GitBranch, MessageSquareText, PhoneForwarded, PhoneIncoming, PhoneOff, TextCursorInput, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import type { CapturedField } from "../agents.schema";
import { heardAs, readBackOf, spokenValue } from "../capture-vocabulary";
import { allFields, servicesOf, type AgentTemplate, type TemplateArm } from "../templates";

/**
 * What a template sounds like — one call at a time.
 *
 * A front desk with six services and thirty questions is not one conversation, and the
 * earlier preview played it as one: every question of every service, in a column taller
 * than the page. No caller ever has that call. What a caller has is the opening and *one*
 * service, so that is what this plays: pick a service and read the call it produces, from
 * the greeting to how it ends. That is the thing somebody choosing a template is actually
 * judging, and it fits beside the form.
 *
 * Where a service forks again, the first option is walked — the preview is a sample call,
 * not a map of every path; the canvas is the map.
 */

/** One caller's way through a template: the opening, then the chosen service to its end. */
interface Walk {
  readonly steps: readonly Step[];
  readonly ending: { readonly kind: "closing" | "handover"; readonly text: string } | null;
}

type Step =
  | { readonly kind: "ask"; readonly field: CapturedField; readonly answer: string }
  | { readonly kind: "fork"; readonly on: CapturedField; readonly chose: string };

const walkArm = (arm: TemplateArm, into: Step[]): Walk["ending"] => {
  for (const field of arm.fields) into.push({ kind: "ask", field, answer: spokenValue(field) });
  if (arm.branch !== undefined) {
    const on = arm.fields.find((field) => field.key === arm.branch?.on);
    const [chose, inner] = Object.entries(arm.branch.arms)[0] ?? [];
    if (on !== undefined && chose !== undefined) {
      // The fork question was pushed as an "ask" above with the first option as its answer,
      // which is the same option this walks — so it reads as one exchange, not two.
      into.pop();
      into.push({ kind: "fork", on, chose });
    }
    return inner === undefined ? null : walkArm(inner, into);
  }
  if (arm.handover !== undefined) return { kind: "handover", text: arm.handover };
  if (arm.closing !== undefined) return { kind: "closing", text: arm.closing };
  return null;
};

const walk = (template: AgentTemplate, service: string | null): Walk => {
  const steps: Step[] = [];
  for (const field of template.fields) {
    if (template.branch !== undefined && field.key === template.branch.on && service !== null) {
      steps.push({ kind: "fork", on: field, chose: service });
    } else {
      steps.push({ kind: "ask", field, answer: spokenValue(field) });
    }
  }
  const arm = service === null ? undefined : template.branch?.arms[service];
  const ending = arm === undefined ? null : walkArm(arm, steps);
  return {
    steps,
    ending: ending ?? (template.closing === undefined ? null : { kind: "closing", text: template.closing }),
  };
};

/**
 * A chat, not a script: the agent on the left, the caller on the right, and no role label on
 * every line — the side says who is speaking, as it does in any messaging app. The flat
 * corner sits where the speaker is, the way a bubble's tail would.
 */
const Line = ({ who, text }: { readonly who: "agent" | "caller"; readonly text: string }) => (
  <div className={cn("flex", who === "agent" ? "justify-start" : "justify-end")}>
    <p
      className={cn(
        "max-w-[86%] border px-3 py-1.5 text-[12.5px] leading-snug",
        who === "agent"
          ? "rounded-[12px] rounded-bl-[4px] border-[var(--hairline)] bg-[var(--surface-2)] text-[var(--ink)]"
          : "rounded-[12px] rounded-br-[4px] border-[color-mix(in_srgb,var(--accent)_26%,transparent)] bg-[var(--accent-soft)] text-[var(--ink)]",
      )}
    >
      {text}
    </p>
  </div>
);

/** How the call ends — an instruction to the agent, so it is set apart from what is said. */
const Ending = ({ ending }: { readonly ending: Walk["ending"] }) => {
  if (ending === null) {
    return <Note icon={PhoneOff} title="Ends the call" text="Says goodbye and hangs up." />;
  }
  return ending.kind === "handover" ? (
    <Note icon={PhoneForwarded} title="Puts them through to a person" text={ending.text} />
  ) : (
    <Note icon={MessageSquareText} title="Then, before hanging up" text={ending.text} />
  );
};

const Note = ({ icon: Icon, title, text }: { readonly icon: LucideIcon; readonly title: string; readonly text: string }) => (
  <div className="mx-auto mt-1 flex max-w-[92%] gap-2 rounded-[10px] border border-dashed border-[var(--hairline)] px-3 py-2">
    <Icon aria-hidden className="mt-0.5 size-3.5 flex-none text-[var(--accent)]" />
    <span>
      <span className="block text-[11.5px] font-medium">{title}</span>
      <span className="block text-[11.5px] text-[var(--ink-3)]">{text}</span>
    </span>
  </div>
);

const Transcript = ({ template, walked }: { readonly template: AgentTemplate; readonly walked: Walk }) => (
  <div className="flex flex-col gap-1.5">
    {template.greeting !== "" && <Line who="agent" text={template.greeting} />}
    {walked.steps.map((step, at) =>
      step.kind === "fork" ? (
        <div key={at} className="flex flex-col gap-1.5">
          {/* The greeting already asks what they rang about; asking again right after it
              would be two agent turns in a row, which no agent gets to have. */}
          {!(at === 0 && template.greeting !== "") && <Line who="agent" text={step.on.prompt} />}
          <Line who="caller" text={step.chose} />
        </div>
      ) : (
        <div key={at} className="flex flex-col gap-1.5">
          <Line who="agent" text={step.field.prompt === "" ? `asks for their ${step.field.key}` : step.field.prompt} />
          <Line who="caller" text={heardAs(step.field, step.answer)} />
          {step.field.confirm !== "none" && (
            <>
              <Line who="agent" text={readBackOf(step.field, step.answer)} />
              <Line who="caller" text="Yes." />
            </>
          )}
        </div>
      ),
    )}
    <Ending ending={walked.ending} />
  </div>
);

/** The same walk as steps on the canvas, for the flow builder. */
const Steps = ({ walked }: { readonly walked: Walk }) => {
  const rows: { readonly icon: LucideIcon; readonly title: string; readonly detail: string }[] = [
    { icon: PhoneIncoming, title: "Call answered", detail: "The caller has picked up, or dialled in." },
    ...walked.steps.map((step) =>
      step.kind === "fork"
        ? { icon: GitBranch, title: `Branch — they said “${step.chose}”`, detail: step.on.prompt }
        : { icon: TextCursorInput, title: "Collect a value", detail: step.field.prompt === "" ? step.field.key : step.field.prompt },
    ),
  ];
  if (walked.ending?.kind === "handover") rows.push({ icon: PhoneForwarded, title: "Transfer to a person", detail: walked.ending.text });
  else if (walked.ending !== null) rows.push({ icon: MessageSquareText, title: "Say", detail: walked.ending.text });
  if (walked.ending?.kind !== "handover") rows.push({ icon: PhoneOff, title: "End the call", detail: "Says goodbye and hangs up." });
  return (
    <ol className="flex flex-col">
      {rows.map((row, at) => (
        <li key={at} className="flex gap-2.5">
          <span className="flex flex-col items-center">
            <span className="grid size-7 flex-none place-items-center rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)]">
              <row.icon aria-hidden className="size-3.5 text-[var(--accent)]" />
            </span>
            {at < rows.length - 1 && <span aria-hidden className="my-0.5 w-px flex-1 bg-[var(--hairline)]" />}
          </span>
          <span className="pb-3">
            <span className="block text-[12.5px] font-medium">{row.title}</span>
            <span className="block text-[12px] text-[var(--ink-3)]">{row.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
};

export const TemplatePreview = ({ template, mode }: { readonly template: AgentTemplate; readonly mode: "form" | "flow" }) => {
  const services = servicesOf(template);
  // Mounted with `key={template.id}` by the caller, so a new template is a fresh choice
  // rather than an old one pointing at a service that no longer exists.
  const [service, setService] = useState<string | null>(services[0] ?? null);

  const walked = walk(template, service);
  const questions = allFields(template).length;
  const handovers = services.filter((one) => template.branch?.arms[one]?.handover !== undefined).length;

  if (template.greeting === "" && template.fields.length === 0) {
    return (
      <p className="text-[12.5px] text-[var(--ink-3)]">
        Nothing to preview — this one starts empty, and every word of the call is yours to write.
      </p>
    );
  }

  return (
    /* Three bands, like a messaging window: what to play stays at the top, the call scrolls
       in the middle, the tally stays at the bottom. `min-h-0` on the middle band is what
       lets it scroll instead of stretching the panel past the column it sits beside. */
    <div className="flex h-full min-h-0 flex-col">
      {services.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 text-[11.5px] text-[var(--ink-3)]">
            {mode === "flow" ? "Follow one caller's path. Choose what they rang about:" : "Play one call. Choose what the caller rang about:"}
          </p>
          <div className="flex flex-wrap gap-1" role="group" aria-label="What the caller rang about">
            {services.map((one) => (
              <button
                key={one}
                type="button"
                aria-pressed={one === service}
                onClick={() => setService(one)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[11.5px] transition-colors",
                  one === service
                    ? "border-transparent bg-[var(--accent)] text-[var(--accent-on)]"
                    : "border-[var(--hairline)] text-[var(--ink-2)] hover:border-[var(--ink-3)]",
                )}
              >
                {one}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pb-2">
        {mode === "flow" ? <Steps walked={walked} /> : <Transcript template={template} walked={walked} />}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--hairline)] pt-2.5">
        {services.length > 0 && <Tag tone="accent">{services.length} services</Tag>}
        <Tag>
          {questions} {questions === 1 ? "question" : "questions"} in all
        </Tag>
        {handovers > 0 && (
          <Tag>
            {handovers} to a person
          </Tag>
        )}
      </div>
    </div>
  );
};
