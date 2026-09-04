"use client";

import { Check, PhoneIncoming, PhoneOff, TextCursorInput, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useProgressWhile } from "@/stores/progress.store";

import { Button, CONTROL, Notice, Panel, PanelBody, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { createAgentFromTemplate } from "../agents.actions";
import type { CapturedField } from "../agents.schema";
import { AGENT_TEMPLATES, type AgentTemplate } from "../templates";
import {
  type AuthoringMode,
} from "./authoring-mode";
import { ConversationPreview } from "./conversation-preview";

/**
 * Creating an agent.
 *
 * One screen rather than the six-step wizard this replaces, and that is the substantive
 * change. The wizard walked somebody through fields it could not save and finished by
 * publishing the organisation's single configuration — there was no second agent to create,
 * so it was a guided edit wearing a create button. `POST /agents` exists now, so this
 * actually creates one.
 *
 * Template first, name second. The name is the easy decision and the template is the one
 * worth thinking about, so the preview gets the space: pick a card on the left, read the
 * call it produces on the right, and only then name it.
 *
 * How it is authored — a form or a flow — is asked here rather than on a screen in front of
 * this one. A chooser before the templates would ask somebody to pick an authoring model
 * before they have seen either one, which is a question with no honest answer; asked
 * alongside the templates it is a choice about work they can already see.
 */

/** The starting point somebody lands on. Anything else is a deliberate choice. */
const DEFAULT_TEMPLATE = "customer-service";

const Card = ({
  template,
  selected,
  onSelect,
}: {
  readonly template: AgentTemplate;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={selected}
    className={cn(
      "surface flex flex-col items-start gap-1 rounded-xl border p-3.5 text-left transition-colors",
      selected
        ? "border-[color-mix(in_srgb,var(--accent)_42%,transparent)] bg-[var(--accent-soft)]"
        : "border-[var(--hairline)] hover:border-[var(--ink-3)]",
    )}
  >
    <span className="flex w-full items-center gap-2">
      <span className="flex-1 text-[14px] font-semibold tracking-[-0.012em]">{template.name}</span>
      {selected && <Check aria-hidden className="size-4 flex-none text-[var(--accent)]" />}
    </span>
    <span className="text-[12.5px] text-[var(--ink-3)]">{template.summary}</span>
    <span className="mt-1 flex flex-wrap gap-1.5">
      {template.fields.length > 0 && (
        <Tag>
          {template.fields.length} {template.fields.length === 1 ? "field" : "fields"}
        </Tag>
      )}
      {/* Surfaced on the card because it is the one setting that changes what the carrier
          does rather than what the agent says, and it only makes sense outbound. */}
      {template.answeringMachineDetection && <Tag tone="warn">outbound</Tag>}
    </span>
  </button>
);

/**
 * The front door of one builder.
 *
 * `mode` is decided one screen earlier, on `/agents/new`, where the two builders are the only
 * two things on the page. Here it is a fact about the screen, not a choice on it: the copy,
 * the preview and where Create lands all follow from it, and nothing on this screen offers
 * the other builder.
 */
/**
 * The column of steps a template becomes on the canvas — the same seed `flowFromFields`
 * draws, shown as a list so the preview is the drawing and not a description of it.
 */
const FlowPreview = ({ fields }: { readonly fields: readonly CapturedField[] }) => {
  const steps: readonly { readonly icon: LucideIcon; readonly title: string; readonly detail: string }[] = [
    { icon: PhoneIncoming, title: "Call answered", detail: "The caller has picked up, or dialled in." },
    ...fields.map((field) => ({
      icon: TextCursorInput,
      title: "Collect a value",
      detail: field.prompt === "" ? field.key : field.prompt,
    })),
    { icon: PhoneOff, title: "End the call", detail: "Says goodbye and hangs up." },
  ];
  return (
    <ol className="flex flex-col">
      {steps.map((step, at) => (
        <li key={at} className="flex gap-2.5">
          <span className="flex flex-col items-center">
            <span className="grid size-7 flex-none place-items-center rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)]">
              <step.icon aria-hidden className="size-3.5 text-[var(--accent)]" />
            </span>
            {at < steps.length - 1 && <span aria-hidden className="my-0.5 w-px flex-1 bg-[var(--hairline)]" />}
          </span>
          <span className="pb-3">
            <span className="block text-[12.5px] font-medium">{step.title}</span>
            <span className="block text-[12px] text-[var(--ink-3)]">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
};

export const CreateAgent = ({ mode }: { readonly mode: AuthoringMode }) => {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
  const authoringMode = mode;
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  /* One token for the create and the navigation to the new agent together, rather than one
     that completes and a second that starts — the bar would restart mid-way across. */
  useProgressWhile(creating);

  const template = AGENT_TEMPLATES.find((one) => one.id === templateId);

  const create = (): void => {
    setFailure(null);
    startCreating(async () => {
      /* Built as an object first rather than written inline, because `createAgentFromTemplate`
         does not read `authoringMode` yet — the column, the API and the action are being
         widened in parallel with this screen. Sending it now costs nothing and means the
         choice reaches creation the moment the action reads it, rather than being collected
         here and dropped. If it is still ignored when both halves have landed, that is the
         bug to look for. */
      const input = { name, templateId, authoringMode };
      const result = await createAgentFromTemplate(input);
      if (!result.ok) {
        setFailure(result.message);
        return;
      }
      // Straight to the agent, warning and all: it exists either way, and the place to
      // finish it is the page it already has — for a flow, that page is the canvas.
      router.push(`/agents/${result.agentId}`);
    });
  };

  return (
    <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-3.5">
        <Panel>
          <PanelBody>
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium">Agent name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="Customer service"
                className={CONTROL}
              />
              <span className="mt-1.5 block text-[12.5px] text-[var(--ink-3)]">
                For you, not the caller — it is how this agent is listed and how its calls
                are attributed. What the agent calls itself when it answers is the greeting.
              </span>
            </label>
          </PanelBody>
        </Panel>

        <div>
          <h2 className="text-[13px] font-medium">Start from</h2>
          <p className="mt-1 mb-2.5 max-w-[62ch] text-[12.5px] text-[var(--ink-3)]">
            Every word of this is editable afterwards. The template decides what the agent
            asks for and how it confirms each answer, which is the part worth getting close
            before the first call.
            {authoringMode === "flow" &&
              " Its questions become the flow's first steps, wired top to bottom, and you take it from there on the canvas."}
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {AGENT_TEMPLATES.map((one) => (
              <Card
                key={one.id}
                template={one}
                selected={one.id === templateId}
                onSelect={() => setTemplateId(one.id)}
              />
            ))}
          </div>
        </div>

        {template !== undefined && template.instructions !== "" && (
          <Panel>
            <PanelBody>
              <h3 className="text-[13px] font-medium">House rules this template comes with</h3>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                {template.instructions}
              </p>
              {/* Shown rather than hidden behind the create: house rules are the part of a
                  template somebody is most likely to want to change, and seeing them before
                  agreeing to them is cheaper than finding them on the Conversation tab
                  afterwards. They are applied with everything else. */}
              <p className="mt-3 text-[12px] text-[var(--ink-3)]">
                Applied when the agent is created. Edit them any time
                {authoringMode === "flow" ? " under Conversation in the canvas's Settings." : " on its Conversation tab."}
              </p>
            </PanelBody>
          </Panel>
        )}

        {failure !== null && <Notice tone="error">{failure}</Notice>}

        <div className="flex items-center gap-2.5">
          <Button variant="primary" onClick={create} disabled={creating || name.trim() === ""}>
            {creating ? "Creating…" : "Create agent"}
          </Button>
          <span className="text-[12.5px] text-[var(--ink-3)]">
            It starts unrouted — no caller reaches it until an operator points a number at
            it.
          </span>
        </div>
      </div>

      <div className="glass self-start rounded-xl p-4 lg:sticky lg:top-4">
        {authoringMode === "flow" ? (
          <>
            <h3 className="text-[13.5px] font-semibold">The flow this draws</h3>
            <p className="mt-1 mb-3.5 text-[12.5px] text-[var(--ink-3)]">
              The steps the canvas opens with, top to bottom. Branch it from there.
            </p>
            {template === undefined ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
            ) : (
              <FlowPreview fields={template.fields} />
            )}
          </>
        ) : (
          <>
            <h3 className="text-[13.5px] font-semibold">How this will sound</h3>
            <p className="mt-1 mb-3.5 text-[12.5px] text-[var(--ink-3)]">
              The call this template produces, generated from its own settings.
            </p>
            {template === undefined ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
            ) : (
              <ConversationPreview greeting={template.greeting} fields={template.fields} />
            )}
          </>
        )}
      </div>
    </div>
  );
};
