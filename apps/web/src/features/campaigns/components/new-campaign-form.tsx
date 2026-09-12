"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";

import {
  Button,
  buttonClass,
  Card,
  SelectField,
  Stack,
  SubmitButton,
  TextField,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";

import { useFailureToast } from "@/stores/toast.store";
import { createCampaignAction, type CreateCampaignState } from "../campaigns.actions";
import { campaignTemplateById } from "../campaign-templates";
import { windowSummary } from "../campaigns.display";
import {
  CallingWindowFields,
  DEFAULT_DRAFT,
  WindowChoice,
  draftToWindow,
  windowToDraft,
  type WindowDraft,
} from "./calling-window-fields";
import {
  BrowseTemplatesButton,
  CampaignTemplateGallery,
  ChosenTemplate,
  TemplateCard,
} from "./campaign-template-picker";

const START: CreateCampaignState = idleForm();

export interface AgentChoice {
  readonly agentId: string;
  readonly name: string;
}

/**
 * Start a campaign, on its own page.
 *
 * It was a dialog, and a dialog was the wrong container: this is five decisions, one of which
 * — the calling window — is the thing operators most often get wrong, and a cramped modal
 * gave it a checkbox and seven tick boxes with no way to see what the result meant. A page
 * has room for the answer to be shown back.
 *
 * That is what the summary beside the form is for. It reads the same `windowSummary` the
 * campaign's own page uses, so what somebody is promised here is rendered by the code that
 * will describe it afterwards — the two cannot drift into saying different things about the
 * same window.
 *
 * The field names are unchanged and deliberately so: `windowEnabled`, `startHour`, `endHour`
 * and the repeated `weekdays` are what `windowFromForm` reads, and the day pills post hidden
 * inputs under that name rather than inventing a payload the action would ignore.
 */
export const NewCampaignForm = ({ agents }: { readonly agents: readonly AgentChoice[] }) => {
  const [state, action, pending] = useActionState(createCampaignAction, START);
  useFailureToast(state);
  const errors = state.fieldErrors;

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const template = campaignTemplateById(templateId);
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState<WindowDraft>(DEFAULT_DRAFT);

  const agentName = agents.find((agent) => agent.agentId === agentId)?.name ?? null;

  /* Built from the same shape the API stores, so the sentence below is the one the campaign
     page will show once this is saved rather than a second description of it. */
  const summary = useMemo(() => windowSummary(draftToWindow(draft)), [draft]);

  /* A template suggests a name and brings its window, and neither is forced: a name already
     typed is kept, and the window can be narrowed afterwards. Picking "scratch" clears only
     what a template put there. */
  const pick = (id: string): void => {
    setTemplateId(id);
    const next = campaignTemplateById(id);
    if (next !== null) {
      if (name.trim() === "" || name === template?.name) setName(next.name);
      setDraft(windowToDraft(next.callingWindow));
    } else if (name === template?.name) {
      setName("");
    }
  };


  if (agents.length === 0) {
    return (
      <Card
        title="There is no agent to place the calls"
        description="A campaign is an agent ringing a list of people. Build the agent first and the campaign takes a minute."
      >
        <div>
          <Link href="/agents/new" className={buttonClass("primary")}>
            Build an agent
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <form action={action} className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
      <Stack>
        <Card
          title="Start from"
          description="A campaign somebody actually runs, with its reason, its verdicts and its retry policy written for the subject — or a blank one. Everything it fills in can be changed on the next screen."
        >
          {/* The pick, carried to the action under its own name. */}
          <input type="hidden" name="templateId" value={templateId} />

          {/* The same shape as the agent create page: the chosen card on the page, the grid
              behind a Browse button. Somebody who has built an agent already knows this. */}
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
            {template === null ? (
              <p className="text-[12.5px] text-[var(--ink-3)]">
                Starting from scratch — a name and an agent, nothing filled in.
              </p>
            ) : (
              <TemplateCard template={template} selected onPick={() => setBrowsing(true)} />
            )}
            <div className="flex flex-col gap-1.5">
              <BrowseTemplatesButton onClick={() => setBrowsing(true)} />
              {template !== null && (
                <Button variant="ghost" onClick={() => pick("")}>
                  Start from nothing
                </Button>
              )}
            </div>
          </div>

          {template !== null && (
            <div className="mt-3.5">
              <ChosenTemplate template={template} />
            </div>
          )}

          <CampaignTemplateGallery
            open={browsing}
            onClose={() => setBrowsing(false)}
            selectedId={templateId}
            onSelect={pick}
          />
        </Card>

        <Card
          title="What it is"
          description="A name you will recognise on the list in a month, and the agent whose script and voice these calls run."
        >
          <Stack>
            <TextField
              label="Name"
              name="name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. October arrears follow-up"
              error={errors["name"]}
            />

            <SelectField
              label="Agent"
              name="agentId"
              required
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
              error={errors["agentId"]}
              hint="Its published configuration is what every call on this campaign uses."
            >
              <option value="" disabled>
                Choose an agent
              </option>
              {agents.map((agent) => (
                <option key={agent.agentId} value={agent.agentId}>
                  {agent.name}
                </option>
              ))}
            </SelectField>
          </Stack>
        </Card>

        <Card
          title="When it may ring"
          description="Nigerian rules bound every outbound call to 08:00–20:00 WAT. This decides whether to narrow that further."
        >
          <Stack>
            <WindowChoice chosen={draft.mode} onChoose={(mode) => setDraft({ ...draft, mode })} />
            <CallingWindowFields draft={draft} errors={errors} onChange={setDraft} />
          </Stack>
        </Card>

      </Stack>

      {/* Sticky on a tall screen: the summary is what the buttons commit to, so it should not
          scroll away from them. */}
      <aside className="lg:sticky lg:top-5">
        <Card title="What you are creating">
          <Stack gap="sm">
            <p className="text-[15px] leading-snug font-medium text-[var(--ink)]">
              {name.trim() === "" ? "An unnamed campaign" : name.trim()}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
              {agentName === null ? (
                <span className="text-[var(--ink-3)]">No agent chosen yet.</span>
              ) : (
                <>
                  <span className="font-medium text-[var(--ink)]">{agentName}</span> places the
                  calls.
                </>
              )}
            </p>
            <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">{summary}</p>
            {template !== null && (
              <p className="text-[12.5px] leading-relaxed text-[var(--ink-2)]">
                Opens by saying it is calling{" "}
                <span className="text-[var(--ink)]">…{template.purpose}</span>
                {template.conversation !== null && ", with a conversation drawn for what they say back"}.
              </p>
            )}

            <hr className="my-1 border-0 border-t border-[var(--hairline)]" />

            {/* Stated, not buried. These hold whatever is chosen above, and somebody setting up
                their first campaign should not have to find that out from the docs. */}
            <ul className="flex flex-col gap-1.5 text-[12px] leading-relaxed text-[var(--ink-3)]">
              <li>Starts as a draft with nobody on it. Nothing is dialled until you start it.</li>
              <li>Do-not-call and consent are checked per number, on every call.</li>
              <li>A number that refuses is never rung again by this campaign.</li>
            </ul>

            <div className="mt-1.5 flex flex-wrap gap-2">
              <SubmitButton pending={pending} idle="Create campaign" />
              <Link href="/campaigns" className={buttonClass()} aria-disabled={pending}>
                Cancel
              </Link>
            </div>
            <p className="text-[11.5px] text-[var(--ink-3)]">
              You add the people it rings on the next screen.
            </p>
          </Stack>
        </Card>
      </aside>
    </form>
  );
};
