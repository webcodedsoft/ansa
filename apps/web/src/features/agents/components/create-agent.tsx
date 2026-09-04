"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { useProgressWhile } from "@/stores/progress.store";

import { Button, CONTROL, Notice, Panel, PanelBody } from "@/components/ui";

import { createAgentFromTemplate } from "../agents.actions";
import { findTemplate } from "../templates";
import {
  type AuthoringMode,
} from "./authoring-mode";
import { BrowseTemplatesButton, TemplateCard, TemplateGallery } from "./template-gallery";
import { TemplatePreview } from "./template-preview";

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

      {/* The same height as the form beside it, exactly. The panel is taken out of the row's
          height calculation — absolute inside its cell — so the row is as tall as the form
          and no taller, and the call scrolls inside the panel rather than running past
          "Create agent". Below `lg` the columns stack and the panel is an ordinary block. */}
      <div className="relative lg:min-h-0">
        <div className="glass flex flex-col rounded-xl p-4 lg:absolute lg:inset-0">
          <h3 className="text-[13.5px] font-semibold">{authoringMode === "flow" ? "The flow this draws" : "How this will sound"}</h3>
          <p className="mt-1 mb-3 text-[12.5px] text-[var(--ink-3)]">
            {authoringMode === "flow"
              ? "One caller's path through the canvas, from answer to end."
              : "One call this template produces, from its own settings."}
          </p>
          {template === null ? (
            <p className="text-[12.5px] text-[var(--ink-3)]">Pick a starting point.</p>
          ) : (
            <TemplatePreview key={template.id} template={template} mode={authoringMode} />
          )}
        </div>
      </div>
    </div>
  );
};
