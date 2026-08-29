"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useProgressWhile } from "@/stores/progress.store";

import { Button, CONTROL, Notice, Panel, PanelBody, Tag } from "@/components/ui";
import { cn } from "@/lib/cn";

import { createAgentFromTemplate } from "../agents.actions";
import { AGENT_TEMPLATES, type AgentTemplate } from "../templates";
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

export const CreateAgent = () => {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
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
      const result = await createAgentFromTemplate({ name, templateId });
      if (!result.ok) {
        setFailure(result.message);
        return;
      }
      // Straight to the agent, warning and all: it exists either way, and the place to
      // finish it is the page it already has.
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
                Applied when the agent is created. Edit them any time on its Conversation tab.
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
        <h3 className="text-[13.5px] font-semibold">How this will sound</h3>
        <p className="mt-1 mb-3.5 text-[12.5px] text-[var(--ink-3)]">
          The call this template produces, generated from its own settings.
        </p>
        {template === undefined ? (
          <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
        ) : (
          <ConversationPreview greeting={template.greeting} fields={template.fields} />
        )}
      </div>
    </div>
  );
};
