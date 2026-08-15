"use client";

import { useActionState } from "react";

import Link from "next/link";

import { Blip, Notice, SubmitButton, Tabs, Tag } from "@/components/ui";
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
          {/* Submits the form below from up here — `form` is a plain HTML attribute, so
              this needs no client state and keeps the button where the mock puts it. */}
          <SubmitButton
            pending={pending}
            idle="Publish"
            busy="Publishing…"
            form={PUBLISH_FORM}
          />
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
          </Notice>
        )}

        {/* One quiet line rather than a panel. The note is required — it is what makes a
            version explicable three weeks later — but it is not what somebody came to this
            page to look at, and a bordered card for one input pushed the tabs below the
            fold. The label rides in the placeholder; the error, when there is one, is the
            only thing that grows. */}
        <div className="mb-3.5 flex flex-wrap items-center gap-2.5">
          <label
            htmlFor="publish-note"
            className="flex-none font-mono text-[10px] font-medium tracking-[0.13em] text-[var(--ink-3)] uppercase"
          >
            What changed
          </label>
          <input
            id="publish-note"
            name="note"
            maxLength={500}
            required
            placeholder="Shortened the greeting — recorded on the version"
            aria-invalid={errors["note"] !== undefined}
            className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--hairline)] bg-[var(--surface-2)] px-3 text-[13px] text-[var(--ink)] placeholder:text-[var(--ink-3)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] aria-[invalid=true]:border-[var(--bad)]"
          />
        </div>
        {errors["note"] !== undefined && (
          <p className="mb-3.5 text-[12.5px] text-[var(--bad)]">{errors["note"]}</p>
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
            { id: "conversation", label: "Conversation", panel: <ConversationTab agent={agent} config={config} errors={errors} publishForm={PUBLISH_FORM} publishing={pending} /> },
            { id: "data", label: "Data captured", panel: <DataCapturedTab agent={agent} /> },
            { id: "tools", label: "Tools", panel: <ToolsTab agent={agent} tools={tools} /> },
            {
              id: "knowledge",
              label: "Knowledge",
              panel: <KnowledgeTab agent={agent} knowledge={knowledge} />,
            },
            { id: "voice", label: "Voice", panel: <VoiceTab config={config} agent={agent} errors={errors} /> },
            { id: "routing", label: "Routing & hours", panel: <RoutingTab config={config} operatorManaged={operatorManaged} errors={errors} /> },
            { id: "versions", label: "Versions", panel: <VersionsTab versions={versions} liveVersion={agent.configVersion} /> },
          ]}
        />
      </form>
    </>
  );
};
