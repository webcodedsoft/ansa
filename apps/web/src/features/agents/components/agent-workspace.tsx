"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import Link from "next/link";

import {
  Blip,
  Button,
  Modal,
  Notice,
  SubmitButton,
  Tabs,
  Tag,
  TextAreaField,
  buttonClass,
  type TabDef,
} from "@/components/ui";
import { idleForm } from "@/lib/form-state";
import { dayLabel, when, phone } from "@/lib/format";
import { useFormToast } from "@/stores/toast.store";

import type { CallSummary } from "@/features/calls/calls.service";

import {
  discardDraftAction,
  retireAgent,
  publish,
  saveDraftAction,
  type DiscardDraftState,
  type RetireState,
  type PublishState,
  type SaveDraftState,
} from "../agents.actions";
import type {
  AgentDraft,
  AgentFlowDocument,
  AgentSummary,
  KnowledgeDocument,
  LiveConfiguration,
  readTools,
} from "../agents.service";
import { branchCount } from "../flow-questions";
import { readFlow } from "../flow.schema";
import { validateFlow } from "@ansa/shared/flow-validate";

import { useWidePage } from "@/stores/layout.store";
import { ConversationTab } from "./conversation-tab";
import { DataCapturedTab } from "./data-captured-tab";
import { FlowCanvas } from "./flow-canvas";
import { SettingsStrip, type StripItem } from "./settings-strip";
import { OverviewTab, type AgentStats, type AttentionItem } from "./overview-tab";
import { PolicyTab } from "./policy-tab";
import type { HeldNumber } from "./routing-card";
import { RoutingTab } from "./routing-tab";
import { KnowledgeTab } from "./knowledge-tab";
import { registryTools, ToolsTab } from "./tools-tab";
import { VersionsTab, type VersionRow } from "./versions-tab";
import { VoiceTab } from "./voice-tab";

const START: PublishState = idleForm();
const START_SAVE: SaveDraftState = idleForm();
const START_DISCARD: DiscardDraftState = idleForm();
const START_RETIRE: RetireState = idleForm();

/**
 * The one form every tab writes into, and the two things that can be done with it.
 *
 * Its own `action` is **save**, not publish. That is deliberate beyond tidiness: pressing
 * return in any text field submits a form through its default action, and the default here
 * has to be the harmless one. Publish overrides it with `formAction` from inside the dialog,
 * which is the only place it can be reached from.
 */
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
  /* The whole editor is one field, so every policy error lands on this one key. Without the
     entry the tab would never be marked and somebody would be told the publish failed with
     no indication of where. */
  policyBlocks: "policies",
};

const TAB_LABEL: Readonly<Record<string, string>> = {
  conversation: "Conversation",
  voice: "Voice",
  policies: "Policies",
  routing: "Routing & hours",
};

const tabLabel = (id: string): string => TAB_LABEL[id] ?? id;

/** "Voice" · "Voice and Routing & hours" · "Conversation, Voice and Routing & hours". */
const sentenceList = (parts: readonly string[]): string =>
  parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;

/**
 * A key that changes when the values a panel renders change, and not before.
 *
 * Nearly every field in this workspace is an uncontrolled input reading `defaultValue`, and
 * React does not reset those on re-render — so Discard removed the draft, refreshed the page,
 * and left the discarded text sitting in the boxes. A key fixes that by remounting.
 *
 * It used to be one key on the whole form, taken from the draft's timestamp. That was too
 * blunt in a way only staging exposed: every section shares one `updated_at`, so flipping a
 * behaviour switch on the Conversation tab remounted the Voice and Routing panels too and
 * threw away anything typed there but not yet saved. Keying each panel on *its own* content
 * means a panel resets when what it shows changes and stays put when somebody else's does.
 *
 * The value itself, not a timestamp: saving text the server stores unchanged leaves the key
 * alone, so an ordinary save no longer remounts anything at all.
 */
const shownAs = (value: unknown): string => JSON.stringify(value) ?? "none";

interface AgentWorkspaceProps {
  /** The agent record itself — its name, its number, its own version. */
  readonly agent: AgentSummary;
  readonly liveConfiguration: LiveConfiguration;
  /**
   * Saved but not published, or null when there is nothing unpublished.
   *
   * Every tab renders this over the live configuration where it exists — otherwise somebody
   * saves a greeting, comes back tomorrow, and is shown the old one with no sign their work
   * survived. The live values stay reachable through the version list, which is where
   * "what is actually answering the phone" belongs.
   */
  readonly draft: AgentDraft | null;
  /**
   * The graph, published and staged, from its own endpoint.
   *
   * Not folded into `draft`: the canvas is saved from its own screen, so the configuration
   * draft carries no graph and there is nothing to fold.
   */
  readonly graph: AgentFlowDocument;
  /** Every number the organisation holds, for the routing picker. */
  readonly held: readonly HeldNumber[];
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
  held,
  agent,
  liveConfiguration,
  draft,
  graph,
  tools,
  knowledge,
  versions,
  stats,
  attention,
  recentCalls,
}: AgentWorkspaceProps) => {
  const { config: live, published, operatorManaged } = liveConfiguration;
  const [state, action, pending] = useActionState(publish, START);
  const [saveState, save, saving] = useActionState(saveDraftAction, START_SAVE);
  const [discardState, discard, discarding] = useActionState(discardDraftAction, START_DISCARD);
  /* Only the failure is rendered. A retirement that works redirects to the agent list, so
     there is no screen left to show a success on. */
  const [retireState, retire, retiring] = useActionState(retireAgent, START_RETIRE);

  /* Whichever attempt answered last owns the field errors. Both schemas validate the same
     fields, so a name rejected by a save is the same name a publish would reject. */
  const errors = state.status === "idle" ? saveState.fieldErrors : state.fieldErrors;

  /* What the tabs render. The draft where there is one, because that is the work in progress
     — showing the live values under a header that says "unpublished changes" would be
     showing somebody the opposite of what they are about to publish. */
  const config = draft?.config ?? live;

  /**
   * The agent as the tabs should see it: live, with any staged selection laid over the top.
   *
   * Done here rather than by threading three more props through Data captured, Tools and
   * Knowledge. Each of those already reads its selection off `agent`, so overlaying once
   * means they show staged values without knowing drafts exist — and a fourth staged section
   * added later needs one line here rather than an edit to a fourth tab.
   *
   * `??` and not `||`, because an empty array is a staged selection: an agent deliberately
   * reaching no tools must not fall through to the live list. Same for the flags, where the
   * staged value that `||` would swallow is `false` — a barge-in somebody has turned off.
   */
  const staged =
    draft === null
      ? agent
      : {
          ...agent,
          capturedFields: draft.capturedFields ?? agent.capturedFields,
          enabledTools: draft.tools ?? agent.enabledTools,
          knowledgeSources: draft.knowledge ?? agent.knowledgeSources,
          bargeIn: draft.bargeIn ?? agent.bargeIn,
          answeringMachineDetection:
            draft.answeringMachineDetection ?? agent.answeringMachineDetection,
        };

  /* The same overlay the selections get, for the pair the canvas stages. Each half falls
     back independently, because staging a redrawn canvas and switching which editor the
     agent runs on are two separate saves and either can be the only one made. */
  const stagedFlow = graph.draft?.flow ?? graph.flow;
  const stagedMode = graph.draft?.authoringMode ?? graph.authoringMode;
  /* For the Versions tab, which counts what a restore back to a form would remove. */
  const drawn = readFlow(stagedFlow);
  const liveBranches = drawn === null ? 0 : branchCount(drawn);

  useFormToast(state, (data) => `Published version ${data.version}.`);
  useFormToast(saveState, (data) => (data.quiet ? null : "Saved. Nothing is live until you publish."));
  useFormToast(discardState, () => "Unpublished changes discarded.");

  /*
   * Auto-save.
   *
   * Every field on every tab writes into the one form, and the canvas carries its graph in a
   * hidden field of it, so saving is submitting that form — which is what the Save button
   * does. This does the same, quietly, a moment after the last change: `autosave=1` tells
   * the action not to revalidate, since a revalidation re-keys the panels and would reset
   * the field being typed in. The page keeps its own account of the save instead.
   *
   * A change is anything the form hears (`onInput`/`onChange` bubble up from every field)
   * or the canvas reports (`onEdited`). Nothing is submitted while a save, publish or
   * discard is in flight — the pending one wins and the change waits — and nothing is
   * submitted when nothing changed. Edits made while a save is in flight dirty the page
   * again, so they are picked up by the save after.
   */
  const publishForm = useRef<HTMLFormElement>(null);
  const autosaveFlag = useRef<HTMLInputElement>(null);
  const [dirty, setDirty] = useState(false);
  const markDirty = () => setDirty(true);
  const busy = saving || pending || discarding;
  useEffect(() => {
    if (!dirty || busy) return;
    const timer = setTimeout(() => {
      const form = publishForm.current;
      const flag = autosaveFlag.current;
      if (form === null || flag === null) return;
      setDirty(false);
      flag.value = "1";
      form.requestSubmit();
      flag.value = "";
    }, 1500);
    return () => clearTimeout(timer);
  }, [dirty, busy]);
  /* When the last quiet save landed. The server's own account of the draft (`draft`) is only
     as fresh as the last reload, which a quiet save does not ask for. */
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null);
  useEffect(() => {
    if (saveState.status === "succeeded" && saveState.data !== null) setAutosavedAt(saveState.data.updatedAt);
  }, [saveState]);
  /* A save that failed leaves the work unsaved, and the page must say so and try again on
     the next change rather than pretend. Validation failures show on their fields as well. */
  useEffect(() => {
    if (saveState.status === "failed") setDirty(false);
  }, [saveState]);
  /* Leaving with work unsaved is asked about. The browser's own dialog, since a custom one
     cannot stop a navigation. */
  /* A failed save leaves the work unsaved too, whatever `dirty` says: it is cleared after
     a failure so the save is not retried on a loop, and the warning must not go with it. */
  const unsaved = dirty || saving || saveState.status === "failed";
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  /* Discarding must reset every panel and the canvas to what is live, and the keys they
     reset on — the configuration, the graph — do not change when the draft the page never
     heard of (a quiet save's) is thrown away. So a discard bumps this, and it is in every key. */
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (discardState.status === "succeeded") setGeneration((at) => at + 1);
  }, [discardState]);
  const savedAt = autosavedAt ?? draft?.updatedAt ?? null;
  const hasDraft = draft !== null || autosavedAt !== null;

  const problemTabs = new Set(
    Object.keys(errors)
      .map((field) => FIELD_TAB[field])
      .filter((tab): tab is string => tab !== undefined),
  );

  /* Held here rather than left to the textarea, so closing the dialog and opening it again
     does not lose a sentence somebody already typed. */
  const [asking, setAsking] = useState(false);
  /* The drawer beside a flow agent's canvas, holding every panel a form agent has as tabs. */
  /* Which agent setting fills the canvas's right-hand pane, or null when that pane belongs
     to the step being edited. Replaced a boolean for a drawer: settings are no longer a
     place you go, they are a thing the pane shows. */
  const [openSetting, setOpenSetting] = useState<string | null>(null);
  useWidePage(stagedMode === "flow");
  /* What the canvas reports each edit: how many of its problems would refuse a publish. The
     API refuses them anyway; this is so the button says so first, and says where, instead of
     letting somebody write a publish note for a publish that cannot happen. Only a flow's
     problems count — a form agent's canvas is a hidden panel nobody is looking at. */
  const flowBlocking = drawn === null ? 0 : validateFlow(drawn).filter((problem) => problem.blocking).length;
  const cannotPublish = stagedMode === "flow" && flowBlocking > 0;
  /* Offered rather than imposed: when the draft was loaded from a version, that is the most
     likely honest note, and it is the provenance the old rollback used to write by itself. */
  const [note, setNote] = useState(
    draft?.restoredFrom === undefined || draft.restoredFrom === null
      ? ""
      : `Restored version ${draft.restoredFrom}.`,
  );
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

  /**
   * Every panel an agent has, whichever way it is built.
   *
   * For a form agent these are the tabs. For a flow agent they are the drawer beside the
   * canvas, minus nothing: routing, voice, versions and the rest are the same agent either
   * way. Data captured is "Questions" for a flow, since there it is a read-only view of what
   * the canvas asks and the place to switch back to a form.
   */
  const panels: readonly TabDef[] = [
    {
      id: "overview",
      label: "Overview",
      panel: <OverviewTab stats={stats} attention={attention} recentCalls={recentCalls} />,
    },
    { id: "conversation", label: "Conversation", problem: problemTabs.has("conversation"), panel: <ConversationTab key={shownAs([config, generation])} agent={staged} config={config} errors={errors} publishForm={PUBLISH_FORM} savingDraft={saving} /> },
    {
      id: "data",
      label: stagedMode === "flow" ? "Questions" : "Data captured",
      panel: <DataCapturedTab key={shownAs([staged.capturedFields, stagedFlow])} agent={staged} authoringMode={stagedMode} flow={stagedFlow} />,
    },
    { id: "tools", label: "Tools", panel: <ToolsTab key={shownAs(staged.enabledTools)} agent={staged} tools={tools} /> },
    {
      id: "knowledge",
      label: "Knowledge",
      panel: <KnowledgeTab key={shownAs(staged.knowledgeSources)} agent={staged} knowledge={knowledge} />,
    },
    { id: "voice", label: "Voice", problem: problemTabs.has("voice"), panel: <VoiceTab key={shownAs([config, generation])} config={config} errors={errors} publishForm={PUBLISH_FORM} savingDraft={saving} /> },
    { id: "policies", label: "Policies", problem: problemTabs.has("policies"), panel: <PolicyTab key={shownAs([config, generation])} config={config} errors={errors} publishForm={PUBLISH_FORM} savingDraft={saving} /> },
    { id: "routing", label: "Routing & hours", problem: problemTabs.has("routing"), panel: <RoutingTab key={shownAs([config, generation])} agentId={agent.agentId} held={held} config={config} operatorManaged={operatorManaged} errors={errors} publishForm={PUBLISH_FORM} savingDraft={saving} /> },
    { id: "versions", label: "Versions", panel: <VersionsTab agentId={agent.agentId} versions={versions} liveVersion={agent.configVersion} liveShape={stagedMode} liveBranches={liveBranches} /> },
  ];

  /**
   * The strip along the top of the canvas: one button per panel, each carrying its value.
   *
   * Ordered as the caller meets them — what the agent says, how it sounds, what it may do,
   * where the call reaches it — rather than as the tabs happen to be listed. Overview and
   * Questions are left off: the first is a report and the second is the canvas itself.
   */
  const stripItems: readonly StripItem[] = [
    {
      id: "conversation",
      label: "Greeting",
      value: config.greeting === null || config.greeting.trim() === "" ? "not set" : `“${config.greeting}”`,
      tone: problemTabs.has("conversation") ? "problem" : config.greeting === null ? "missing" : undefined,
    },
    {
      id: "voice",
      label: "Voice",
      value: `${config.voiceId ?? "default"}${config.speakingRate === null ? "" : ` · ${config.speakingRate}×`}`,
      tone: problemTabs.has("voice") ? "problem" : undefined,
    },
    {
      id: "policies",
      label: "House rules",
      value: String(config.policyBlocks?.length ?? 0),
      tone: problemTabs.has("policies") ? "problem" : undefined,
    },
    { id: "tools", label: "Tools", value: String(staged.enabledTools.length) },
    {
      id: "knowledge",
      label: "Knowledge",
      value: staged.knowledgeSources.length === 1 ? "1 source" : `${staged.knowledgeSources.length} sources`,
    },
    {
      id: "routing",
      label: "Number",
      value: operatorManaged.dialledNumber === null ? "none yet" : phone(operatorManaged.dialledNumber),
      tone: problemTabs.has("routing") ? "problem" : operatorManaged.dialledNumber === null ? "missing" : undefined,
    },
    { id: "versions", label: "Versions", value: `v${agent.configVersion}` },
    { id: "overview", label: "Overview", value: `${stats.calls7d} calls, 7d` },
  ];

  return (
    <>
      {/* An entity header, not a page header: an agent is a thing you opened,
          so it wears an identity — mark, status, the number it answers on —
          the way the prototype drew it, rather than a section title. */}
      {/* An entity header, not a page header: an agent is a thing you opened, so it wears
          an identity — mark, status, the number it answers on, and who published it last.
          The three controls sit here because they act on the whole agent rather than on
          whichever tab happens to be open. */}
      <header className="glass mb-3.5 flex flex-wrap items-center gap-3.5 rounded-xl p-4">
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
            {/* The whole point of the slice, said on the page: there is work here that is
                not answering the phone. Without this line a saved draft is invisible, and
                "why is the agent still saying the old thing" has no answer on screen. */}
            {hasDraft && savedAt !== null && <Tag tone="warn">unpublished changes · saved {when(savedAt)}</Tag>}
            {/* What auto-save is doing, in three words. "Unsaved changes" is the state that
                matters: it means closing the tab now loses something. */}
            <span className="font-mono text-[10.5px] tracking-[0.06em] text-[var(--ink-3)]" aria-live="polite">
              {saving ? "saving…" : dirty ? "unsaved changes" : saveState.status === "failed" ? "not saved — see the message on the form" : autosavedAt !== null ? "saved" : ""}
            </span>
          </div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <Link href="/agents" className={buttonClass()}>
            All agents
          </Link>
          {/* Anchors to the test-call card rather than duplicating the control. Two
              buttons that place a call is one too many ways to do one thing. */}
          <Link href="#test-call" className={buttonClass()}>
            Test call
          </Link>
          {/* Retiring is a form of its own rather than a button on the publish form, because it
              is the one action here that is not "save what I typed" — submitting the publish
              form to archive an agent would carry every field on it along for the ride. */}
          <form
            action={retire}
            onSubmit={(event) => {
              const confirmed = window.confirm(
                `Retire ${agent.name}? It stops answering immediately and its number is released for another agent. Calls it already handled keep its name.`,
              );
              if (!confirmed) event.preventDefault();
            }}
          >
            <input type="hidden" name="agentId" value={agent.agentId} />
            {/* Danger, not primary. `SubmitButton` defaults to primary, so taking an agent off
                the phone rendered in the same accent as publishing a new configuration to it. */}
            <SubmitButton pending={retiring} idle="Retire" busy="Retiring…" variant="danger" />
          </form>

          {/* Discard first, and only when there is something to discard. A button offering to
              throw away work that does not exist is furniture, and one sitting there
              permanently beside Publish invites the click it should not get. */}
          {hasDraft && (
            <Button
              onClick={() => {
                /* The action is called by the button, not by the page, so it has no route to
                   read the agent from. Same reason the publish form carries a hidden field. */
                const form = new FormData();
                form.set("agentId", agent.agentId);
                setAutosavedAt(null);
                discard(form);
              }}
              disabled={discarding || saving || pending}
              aria-busy={discarding}
            >
              {discarding ? "Discarding…" : "Discard changes"}
            </Button>
          )}

          {/* Save is a submit, so it carries every field on every tab. Publish is not: it
              opens the dialog, because publishing is the one action here that needs something
              from the person first, and asking at the moment they ask to publish is the only
              way to ask without the question standing on the page all visit. */}
          <SubmitButton
            variant="secondary"
            pending={saving}
            idle="Save"
            busy="Saving…"
            form={PUBLISH_FORM}
          />
          <Button
            variant="primary"
            disabled={pending || saving || discarding || cannotPublish}
            aria-busy={pending}
            title={
              cannotPublish
                ? `The flow has ${flowBlocking === 1 ? "a problem" : `${flowBlocking} problems`} that must be fixed in the flow builder first.`
                : undefined
            }
            onClick={() => setAsking(true)}
          >
            {pending ? "Publishing…" : cannotPublish ? `Fix ${flowBlocking} in the flow` : "Publish"}
          </Button>
        </div>
      </header>

      {operatorManaged.dialledNumber === null && (
        <Notice tone="warn" className="mt-3.5">
          No number is pointed at this organisation yet, so nobody can call the agent.
          Placing a test call from the Overview tab still works.
        </Notice>
      )}

      {/* No key on the form. Each panel carries its own — see `shownAs`. */}
      <form id={PUBLISH_FORM} ref={publishForm} action={save} className="mt-3.5" onInput={markDirty} onChange={markDirty}>
        {/* Set to "1" for the instant of a background submit and cleared again — see the
            auto-save effect. The Save button submits with it empty. */}
        <input ref={autosaveFlag} type="hidden" name="autosave" value="" />
        {/* Which agent every button on this form writes to.
            A server action is called by the form, not by the page, so it cannot read the id
            out of the route the way a loader can. Nothing in the type system connects this
            field to `agentFrom` in `agents.actions.ts` — delete it and Save and Publish both
            fail at runtime with a compiling build, which is exactly why the action refuses
            rather than falling back to the organisation's only agent. */}
        <input type="hidden" name="agentId" value={agent.agentId} />
        {retireState.status === "failed" && (
          <Notice tone="error" className="mb-3.5">
            {retireState.message}
          </Notice>
        )}

        {(state.status === "failed" || state.status === "invalid") && (
          <Notice tone="error" className="mb-3.5">
            {state.message}
            {problemTabs.size > 0 && ` On ${sentenceList([...problemTabs].map(tabLabel))}.`}
          </Notice>
        )}

        {/* Two agents, two workspaces, one form. A form agent is built in tabs. A flow agent
            is built on its canvas — the canvas is the page, and everything else about the
            agent sits in a drawer beside it, so a flow author never leaves the drawing. Both
            are the same draft, the same Save and the same Publish, because the fields on
            every panel write into this form by id wherever they are rendered. */}
        {stagedMode === "flow" ? (
          <>
            <SettingsStrip items={stripItems} active={openSetting} onSelect={setOpenSetting} />
            {/* The chosen setting takes the page, and the drawing steps aside until it is
                closed. Hidden rather than unmounted, both ways: every panel carries fields
                the form submits, and the canvas carries the unsaved graph in a hidden field
                of the same form — either unmounted would take its edits with it. The
                `tabpanel` role is what the canvas watches to re-measure when it comes back. */}
            <div hidden={openSetting === null} className="surface mt-3.5 rounded-xl p-5">
              {openSetting !== null && (
                <div className="mb-4 flex items-center justify-between gap-3 border-b border-[var(--hairline)] pb-3">
                  <h2 className="text-[15px] font-[640] tracking-[-0.018em]">{panels.find((panel) => panel.id === openSetting)?.label ?? ""}</h2>
                  <Button size="sm" variant="secondary" onClick={() => setOpenSetting(null)}>
                    Back to the flow
                  </Button>
                </div>
              )}
              {panels.map((panel) => (
                <div key={panel.id} hidden={panel.id !== openSetting}>
                  {panel.panel}
                </div>
              ))}
            </div>
            <div role="tabpanel" hidden={openSetting !== null}>
              <FlowCanvas
                key={shownAs([stagedFlow, stagedMode, generation])}
                flow={stagedFlow}
                publishForm={PUBLISH_FORM}
                authoringMode={stagedMode}
                onBlockingProblems={() => undefined}
                availableTools={registryTools(tools).map((tool) => ({ name: tool.name, enabled: staged.enabledTools.includes(tool.name) }))}
                transferNumber={config.escalation?.toNumber ?? null}
                onOpenSettings={() => setOpenSetting("routing")}
                onEdited={markDirty}
              />
            </div>
          </>
        ) : (
          <Tabs tabs={panels} />
        )}
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
              formAction={action}
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
