"use client";

import { GitBranch, MessageSquareText, PhoneForwarded, PhoneIncoming, PhoneOff, TextCursorInput, type LucideIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useProgressWhile } from "@/stores/progress.store";

import { Button, CONTROL, Notice, Panel, PanelBody } from "@/components/ui";

import { createAgentFromTemplate } from "../agents.actions";
import type { CapturedField } from "../agents.schema";
import { allFields, findTemplate, type AgentTemplate, type TemplateArm } from "../templates";
import {
  type AuthoringMode,
} from "./authoring-mode";
import { ConversationPreview } from "./conversation-preview";
import { BrowseTemplatesButton, TemplateCard, TemplateGallery } from "./template-gallery";

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
 * worth thinking about, so the preview gets the space: choose from the gallery, read the
 * call it produces on the right, and only then name it. The gallery is a modal because
 * seventy cards on this screen would bury the name field and the create button under a
 * page of scrolling; here there is the one that was chosen and a way to change it.
 *
 * How it is authored — a form or a flow — is asked here rather than on a screen in front of
 * this one. A chooser before the templates would ask somebody to pick an authoring model
 * before they have seen either one, which is a question with no honest answer; asked
 * alongside the templates it is a choice about work they can already see.
 */

/** The starting point somebody lands on. Anything else is a deliberate choice. */
const DEFAULT_TEMPLATE = "general-reception";

/**
 * The front door of one builder.
 *
 * `mode` is decided one screen earlier, on `/agents/new`, where the two builders are the only
 * two things on the page. Here it is a fact about the screen, not a choice on it: the copy,
 * the preview and where Create lands all follow from it, and nothing on this screen offers
 * the other builder.
 */
/**
 * The steps a template becomes on the canvas — the same shape `flowFromTemplate` draws,
 * every service, fork and hand-over included, shown as an indented list so the preview is
 * the drawing and not a description of it.
 */
type Step = { readonly icon: LucideIcon; readonly title: string; readonly detail: string; readonly depth: number };

const collectStep = (field: CapturedField, depth: number): Step => ({
  icon: TextCursorInput,
  title: "Collect a value",
  detail: field.prompt === "" ? field.key : field.prompt,
  depth,
});

/** One arm's steps, then its fork's arms, then how it ends — the order the canvas draws. */
const armSteps = (arm: TemplateArm, depth: number, inScope: readonly CapturedField[]): Step[] => {
  const steps = arm.fields.map((field) => collectStep(field, depth));
  const scope = [...inScope, ...arm.fields];
  if (arm.branch !== undefined) {
    const on = scope.find((field) => field.key === arm.branch?.on);
    steps.push({ icon: GitBranch, title: "Branch", detail: `On “${on?.prompt ?? arm.branch.on}”`, depth });
    for (const [option, inner] of Object.entries(arm.branch.arms)) {
      steps.push({ icon: GitBranch, title: `If “${option}”`, detail: "", depth: depth + 1 });
      steps.push(...armSteps(inner, depth + 2, scope));
    }
    return steps;
  }
  if (arm.handover !== undefined) {
    steps.push({ icon: PhoneForwarded, title: "Transfer to a person", detail: arm.handover, depth });
  } else if (arm.closing !== undefined) {
    steps.push({ icon: MessageSquareText, title: "Say, then end", detail: arm.closing, depth });
  }
  return steps;
};

const FlowPreview = ({ template }: { readonly template: AgentTemplate }) => {
  const steps: Step[] = [
    { icon: PhoneIncoming, title: "Call answered", detail: "The caller has picked up, or dialled in.", depth: 0 },
    ...template.fields.map((field) => collectStep(field, 0)),
  ];
  if (template.branch !== undefined) {
    const on = template.fields.find((field) => field.key === template.branch?.on);
    steps.push({ icon: GitBranch, title: "Branch", detail: `On “${on?.prompt ?? template.branch.on}”`, depth: 0 });
    for (const [service, arm] of Object.entries(template.branch.arms)) {
      steps.push({ icon: GitBranch, title: `If “${service}”`, detail: "", depth: 1 });
      steps.push(...armSteps(arm, 2, template.fields));
    }
  }
  if (template.closing !== undefined) {
    steps.push({ icon: MessageSquareText, title: "Say", detail: template.closing, depth: 0 });
  }
  steps.push({ icon: PhoneOff, title: "End the call", detail: "Says goodbye and hangs up.", depth: 0 });
  return (
    <ol className="flex flex-col">
      {steps.map((step, at) => (
        <li key={at} className="flex gap-2.5" style={{ marginLeft: step.depth * 14 }}>
          <span className="flex flex-col items-center">
            <span className="grid size-7 flex-none place-items-center rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)]">
              <step.icon aria-hidden className="size-3.5 text-[var(--accent)]" />
            </span>
            {at < steps.length - 1 && <span aria-hidden className="my-0.5 w-px flex-1 bg-[var(--hairline)]" />}
          </span>
          <span className="pb-3">
            <span className="block text-[12.5px] font-medium">{step.title}</span>
            {step.detail !== "" && <span className="block text-[12px] text-[var(--ink-3)]">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
};

export const CreateAgent = ({ mode }: { readonly mode: AuthoringMode }) => {
  const router = useRouter();
  const [templateId, setTemplateId] = useState(DEFAULT_TEMPLATE);
  const [browsing, setBrowsing] = useState(false);
  const authoringMode = mode;
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  /* One token for the create and the navigation to the new agent together, rather than one
     that completes and a second that starts — the bar would restart mid-way across. */
  useProgressWhile(creating);

  const template = findTemplate(templateId);

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
            Every template is a whole front desk for one kind of organisation — every
            service it is rung about, day to day, with its house rules and the words callers
            use. Pick the one closest to yours; most need nothing more than a name.
            {authoringMode === "flow" &&
              " It is drawn on the canvas as it is, branches and all, and you take it from there."}
          </p>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            {template === null ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
            ) : (
              <TemplateCard template={template} mode={authoringMode} selected onPick={() => setBrowsing(true)} />
            )}
            <div className="flex flex-col gap-1.5">
              <BrowseTemplatesButton onClick={() => setBrowsing(true)} />
              {templateId !== "blank" && (
                <Button variant="ghost" onClick={() => setTemplateId("blank")}>
                  Start from nothing
                </Button>
              )}
            </div>
          </div>
          <TemplateGallery
            open={browsing}
            onClose={() => setBrowsing(false)}
            selectedId={templateId}
            onSelect={setTemplateId}
            mode={authoringMode}
          />
        </div>

        {template !== null && template.instructions !== "" && (
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
              What the canvas opens with: the opening, a fork into each service, and how each ends.
            </p>
            {template === null ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
            ) : (
              <FlowPreview template={template} />
            )}
          </>
        ) : (
          <>
            <h3 className="text-[13.5px] font-semibold">How this will sound</h3>
            <p className="mt-1 mb-3.5 text-[12.5px] text-[var(--ink-3)]">
              The call this template produces, generated from its own settings.
            </p>
            {template === null ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
            ) : (
              <ConversationPreview greeting={template.greeting} fields={allFields(template)} />
            )}
          </>
        )}
      </div>
    </div>
  );
};
