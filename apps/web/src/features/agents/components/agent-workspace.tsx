"use client";

import { useActionState, useEffect, useState } from "react";

import Link from "next/link";

import { Blip, Button, Modal, Notice, SubmitButton, Tabs, Tag, TextAreaField } from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { dayLabel, when } from "@/lib/format";
import { useFormToast } from "@/stores/toast.store";

import type { CallSummary } from "@/features/calls/calls.service";

import { publish, type PublishState } from "../agents.actions";
import type { AgentSummary, KnowledgeDocument, LiveConfiguration, readTools } from "../agents.service";
import { ConversationTab } from "./conversation-tab";
import { DataCapturedTab } from "./data-captured-tab";
import { FlowCanvas } from "./flow-canvas";
import { OverviewTab, type AgentStats, type AttentionItem } from "./overview-tab";
import { RoutingTab } from "./routing-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { ToolsTab } from "./tools-tab";
import { VersionsTab, type VersionRow } from "./versions-tab";
import { VoiceTab } from "./voice-tab";

const START: PublishState = idleForm();

/** The header's Publish button submits this form from outside it. */
const PUBLISH_FORM = "agent-publish";

/**
 * Which tab each publishable field lives on.
 *
 * One form spans nine tabs and eight are hidden at any moment, so a rejected field is usually
 * somewhere nobody is looking. Until now the browser refused the submit instead, which at
 * least stopped it — but silently: it will not show a validation bubble for a control it
 * cannot focus, so the button did nothing at all. The server answers instead now, and the
 * answer has to be findable, so the tab holding it is marked and the message names it.
 *
 * `note` is deliberately absent. It belongs to the publish dialog, which shows its own error
 * and stays open to do it.
 */
const FIELD_TAB: Readonly<Record<string, string>> = {
  name: "conversation",
  greeting: "conversation",
  persona: "conversation",
  instructions: "conversation",
  keyterms: "conversation",
  voiceId: "voice",
  speakingRate: "voice",
  opensAtHour: "routing",
  closesAtHour: "routing",
  openDays: "routing",
  toNumber: "routing",
  fromNumber: "routing",
  ringSeconds: "routing",
};

const TAB_LABEL: Readonly<Record<string, string>> = {
  conversation: "Conversation",
  voice: "Voice",
  routing: "Routing & hours",
};

const tabLabel = (id: string): string => TAB_LABEL[id] ?? id;

/** "Voice" · "Voice and Routing & hours" · "Conversation, Voice and Routing & hours". */
const sentenceList = (parts: readonly string[]): string =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

interface AgentWorkspaceProps {
  /** The agent record itself — its name, its number, its own version. */
  readonly agent: AgentSummary;
  readonly liveConfiguration: LiveConfiguration;
  readonly tools: Awaited<ReturnType<typeof readTools>>;
  readonly knowledge: KnowledgeDocument;
  readonly versions: readonly VersionRow[];
  readonly stats: AgentStats;
  readonly attention: readonly AttentionItem[];
  readonly recentCalls: readonly CallSummary[];
}

/**
 * The single agent this organisation has, shown as if it were one of many — because it will
 * be, once the API has a table to back that. `agentId` in the route is accepted and
 * ignored; see the comment in `page.tsx`.
 *
 * Every tab lives inside one `<form>`, including the ones with no editable fields. That is
 * what lets Overview, Flow, Data captured, Tools and Versions sit beside Conversation,
 * Voice and Routing & hours without the publish action losing track of a field the moment
 * it is off-screen — `Tabs` hides panels with the `hidden` attribute rather than unmounting
 * them, precisely so a form spanning tabs like this one keeps working. Nothing inside
 * Overview or Versions is itself a `<form>`, because nesting one would be invalid HTML;
 * those act through their Server Action's dispatch function directly instead.
 */
export const AgentWorkspace = ({
  agent,
  liveConfiguration,
  tools,
  knowledge,
  versions,
  stats,
  attention,
  recentCalls,
}: AgentWorkspaceProps) => {
  const { config, published, operatorManaged } = liveConfiguration;
  const [state, action, pending] = useActionState(publish, START);
  const errors = state.fieldErrors;

  useFormToast(state, (data) => `Published version ${data.version}.`);

  const problemTabs = new Set(
    Object.keys(errors)
      .map((field) => FIELD_TAB[field])
      .filter((tab): tab is string => tab !== undefined),
  );

  /* Held here rather than left to the textarea, so closing the dialog and opening it again
     does not lose a sentence somebody already typed. */
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  /**
   * What the dialog does once the action answers.
   *
   * It stays open only when the note itself was rejected, which is the one failure it can do
   * anything about. Everything else belongs to a field on a tab behind it — the dialog would
   * be covering the marker and the message pointing at it — so it gets out of the way. On
   * success the note is cleared, or the next publish opens holding the last one's reason.
   */
  useEffect(() => {
    if (state.status === "idle" || errors["note"] !== undefined) return;
    setAsking(false);
    if (state.status === "succeeded") setNote("");
  }, [state, errors]);

  return (
    <>
      {/* An entity header, not a page header: an agent is a thing you opened,
          so it wears an identity — mark, status, the number it answers on —
          the way the prototype drew it, rather than a section title. */}
      {/* An entity header, not a page header: an agent is a thing you opened, so it wears
          an identity — mark, status, the number it answers on, and who published it last.
          The three controls sit here because they act on the whole agent rather than on
          whichever tab happens to be open. */}
      <header className="glass mb-3.5 flex flex-wrap items-center gap-3.5 rounded-[18px] p-4">
        <span className="grid size-[38px] flex-none place-items-center rounded-[11px] bg-[linear-gradient(150deg,var(--accent),color-mix(in_srgb,var(--accent)_55%,#2a6ad4))] text-[15px] font-bold text-[var(--accent-on)] shadow-[var(--shadow-s)]">
          {agent.name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-[650] tracking-[-0.022em]">{agent.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--ink-3)]">
            {agent.dialledNumber !== null ? (
              <Tag tone="ok">
                <Blip pulse />
                answering
              </Tag>
            ) : (
              <Tag tone="warn">no number</Tag>
            )}
            {agent.dialledNumber !== null && (
              <span className="font-mono">{agent.dialledNumber}</span>
            )}
            <span>
              {published === null
                ? `· version ${agent.configVersion}, never published`
                : `· version ${agent.configVersion}, published ${dayLabel(published.publishedAt).toLowerCase() === "today" ? "today" : when(published.publishedAt)} by ${published.publishedBy}`}
            </span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <Link
            href="/agents"
            className="inline-flex h-8 items-center rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3 text-[13px] font-medium shadow-[var(--spec)]"
          >
            All agents
          </Link>
          {/* Anchors to the test-call card rather than duplicating the control. Two
              buttons that place a call is one too many ways to do one thing. */}
          <Link
            href="#test-call"
            className="inline-flex h-8 items-center rounded-lg border border-[var(--hairline)] bg-[var(--glass-hi)] px-3 text-[13px] font-medium shadow-[var(--spec)]"
          >
            Test call
          </Link>
          {/* Opens the dialog rather than submitting. Publishing is the one action here that
              needs something from the person first, and asking for it at the moment they ask
              to publish is the only way to ask without the question standing on the page for
              the whole visit. The actual submit is the dialog's own button. */}
          <Button
            variant="primary"
            disabled={pending}
            aria-busy={pending}
            onClick={() => setAsking(true)}
          >
            {pending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </header>

      {operatorManaged.dialledNumber === null && (
        <Notice tone="warn" className="mt-3.5">
          No number is pointed at this organisation yet, so nobody can call the agent.
          Placing a test call from the Overview tab still works.
        </Notice>
      )}

      <form id={PUBLISH_FORM} action={action} className="mt-3.5">
        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error" className="mb-3.5">
            {state.message}
            {problemTabs.size > 0 && ` On ${sentenceList([...problemTabs].map(tabLabel))}.`}
          </Notice>
        )}

        <Tabs
          tabs={[
            {
              id: "overview",
              label: "Overview",
              panel: (
                <OverviewTab stats={stats} attention={attention} recentCalls={recentCalls} />
              ),
            },
            { id: "flow", label: "Flow", panel: <FlowCanvas /> },
            { id: "conversation", label: "Conversation", problem: problemTabs.has("conversation"), panel: <ConversationTab agent={agent} config={config} errors={errors} /> },
            { id: "data", label: "Data captured", panel: <DataCapturedTab agent={agent} /> },
            { id: "tools", label: "Tools", panel: <ToolsTab agent={agent} tools={tools} /> },
            {
              id: "knowledge",
              label: "Knowledge",
              panel: <KnowledgeTab agent={agent} knowledge={knowledge} />,
            },
            { id: "voice", label: "Voice", problem: problemTabs.has("voice"), panel: <VoiceTab config={config} agent={agent} errors={errors} publishForm={PUBLISH_FORM} /> },
            { id: "routing", label: "Routing & hours", problem: problemTabs.has("routing"), panel: <RoutingTab config={config} operatorManaged={operatorManaged} errors={errors} /> },
            { id: "versions", label: "Versions", panel: <VersionsTab versions={versions} liveVersion={agent.configVersion} /> },
          ]}
        />
      </form>

      {/* Outside the form on purpose. `form=` binds the field and the button to it by id, so
          the dialog can collect the last thing the submit needs without the overlay being
          part of the form's layout — and without the note existing at all when a tab's own
          save button is the one publishing. */}
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Publish this configuration"
        description="Everything on every tab goes live together, as one version. Say what changed so the entry in the history means something to whoever reads it next."
        footer={
          <>
            <Button onClick={() => setAsking(false)} disabled={pending}>
              Cancel
            </Button>
            <SubmitButton
              pending={pending}
              idle="Publish"
              busy="Publishing…"
              form={PUBLISH_FORM}
            />
          </>
        }
      >
        <TextAreaField
          autoFocus
          required
          label="What changed"
          name="note"
          form={PUBLISH_FORM}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={500}
          /* The rejection is "you did not say anything", so it stops applying the moment
             they say something — otherwise it sits under a sentence that answers it, which
             is what the last version of this did. Keyed on the field being empty rather
             than on the value that was submitted, because the answer can arrive after
             somebody has started typing and anything time-based puts the message back
             underneath their new text. `maxLength` makes the only other note rule
             unreachable from here; if one a non-empty note can fail is ever added, this has
             to compare against what was sent instead. */
          error={note.trim() === "" ? errors["note"] : undefined}
          placeholder="Shortened the greeting and slowed the voice for the Lagos line."
        />
      </Modal>
    </>
  );
};
