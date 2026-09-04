import { api } from "@/lib/api/server";

import type { DraftBody, PublishBody, TestCallInput } from "./agents.schema";

/**
 * Everything this app does with an agent's configuration.
 *
 * Every configuration call now names its agent. It used to name none: the API had one
 * configuration per organisation and resolved the oldest live agent in the database, so
 * `/agents/[agentId]` read and published the same document whatever id was in the URL — right
 * while an organisation could only have one agent, and a silent coin toss the moment it could
 * have two. The id these functions take is the one from the route.
 *
 * Keeping every call in one file is what stops the list page, the workspace and the wizard
 * from disagreeing about the shape of a configuration — and it is why threading the agent
 * through cost twelve lines rather than a sweep of every screen.
 */

/**
 * Every agent this organisation runs, oldest first (migration 0018).
 *
 * Includes retired ones, because a call log referencing an agent still needs its name.
 * Screens offering a choice filter on `deletedAt` — see `liveAgents`.
 */
export const listAgents = async () => (await api()).agents.list();

/** The ones that can still answer a call. What the list page and any picker should show. */
export const liveAgents = async () => {
  const { items } = await listAgents();
  return items.filter((agent) => agent.deletedAt === null);
};

export const findAgent = async (agentId: string) =>
  (await api()).agents.read({ path: { agentId } });

export const createAgent = async (body: {
  readonly name: string;
  readonly persona?: string | null;
  readonly greeting?: string | null;
  readonly instructions?: string | null;
  readonly voiceId?: string | null;
  readonly dialledNumber?: string | null;
}) => (await api()).agents.create({ body });

/**
 * Move which of this organisation's numbers an agent answers.
 *
 * There was no wrapper here, and the note explaining that has stopped being true. It said the
 * endpoint still wrote publish-form fields live — a hole worth not reaching for — but
 * `agentEdit` was narrowed to routing alone, so `dialledNumber` is now the only thing it
 * accepts. Everything an agent *says* is published; which line reaches it is not.
 *
 * Applies immediately, like the organisation's hours and for the same reason: routing has
 * never been part of a configuration version, so there is nothing to stage it into. Null
 * unroutes the agent, which is a real state — an agent can be written and reviewed before it
 * is given a line.
 */
export const routeAgent = async (agentId: string, dialledNumber: string | null) =>
  (await api()).agents.update({ path: { agentId }, body: { dialledNumber } });

/**
 * Stage a behaviour switch. Nothing about a live call changes until somebody publishes.
 *
 * Only the switch that moved is sent. An omitted flag is left as it was — staged or live —
 * so flipping barge-in cannot revert answering-machine detection to whatever this page read
 * when it rendered.
 */
export const stageAgentBehaviour = async (
  agentId: string,
  body: { readonly bargeIn?: boolean; readonly answeringMachineDetection?: boolean },
) => (await api()).agents.setBehaviour({ path: { agentId }, body });

/** Retires the agent and releases its number. The API archives rather than deletes. */
export const archiveAgent = async (agentId: string) =>
  (await api()).agents.archive({ path: { agentId } });

/** The whole form, in order. Order is what the caller hears, so it is never patched. */
export const setAgentFields = async (agentId: string, fields: readonly unknown[]) =>
  (await api()).agents.setFields({ path: { agentId }, body: { fields: [...fields] } as never });

/** The whole selection, not a patch — what is on screen is what gets saved. */
export const setAgentTools = async (agentId: string, tools: readonly string[]) =>
  (await api()).agents.setTools({ path: { agentId }, body: { tools: [...tools] } });

/**
 * The graph, published and staged, as one read.
 *
 * Separate from the configuration draft on purpose: the canvas is saved from its own screen,
 * so `GET /config/:agentId/draft` does not carry a graph and asking it for one would report
 * every flow-authored agent as having nothing staged.
 */
export const readAgentFlow = async (agentId: string) =>
  (await api()).agents.readFlow({ path: { agentId } });

export type AgentFlowDocument = Awaited<ReturnType<typeof readAgentFlow>>;

/**
 * The whole graph, and which editor the agent runs on, staged onto the draft.
 *
 * Both halves are optional and independently staged, which matters: redrawing a canvas is
 * not a request to switch onto it, and switching back to a form is not a request to delete
 * it. Omitting one leaves the stored value alone.
 */
export const setAgentFlow = async (
  agentId: string,
  body: { readonly flow?: unknown; readonly authoringMode?: "form" | "flow" },
) => (await api()).agents.setFlow({ path: { agentId }, body: body as never });

export type AgentSummary = Awaited<ReturnType<typeof listAgents>>["items"][number];

/**
 * The agent an organisation-wide screen means when it has no agent in its route.
 *
 * The call list and the organisation settings page both need something off a configuration
 * document — a version caption, the operator's consent window — and neither has an agent id
 * to work from. They used to get one for free, because the API resolved the organisation's
 * oldest live agent itself. Now that the route names the agent, that assumption has to live
 * somewhere, and here is better than inside a query: it is one function to find when the
 * console grows a second agent, and it is honest that a screen is choosing.
 *
 * Null when there is no live agent. More than one is not an error here — the first is
 * returned, matching what the database used to do — but it is the case that makes these two
 * screens wrong, and the reason they are worth revisiting before a second agent ships.
 */
export const soleLiveAgentId = async (): Promise<string | null> => {
  const live = await liveAgents();
  return live[0]?.agentId ?? null;
};

export const currentConfiguration = async (agentId: string) =>
  (await api()).config.current({ path: { agentId } });

export type LiveConfiguration = Awaited<ReturnType<typeof currentConfiguration>>;

export const publishConfiguration = async (agentId: string, body: PublishBody) => {
  const result = await (await api()).config.publish({ path: { agentId }, body });
  return result;
};


export const listVersions = async (agentId: string, page?: number) =>
  (await api()).config.listVersions({
    path: { agentId },
    query: { perPage: 25, ...(page === undefined ? {} : { page }) },
  });

export const getVersion = async (agentId: string, version: number) =>
  (await api()).config.version({ path: { agentId, version } });

export const diffVersions = async (agentId: string, from: number, to: number) =>
  (await api()).config.diff({ path: { agentId }, query: { from, to } });

/**
 * Puts a published version back on screen. It does not publish it.
 *
 * Named `rollbackToVersion` still, because the route is still `rollback` and renaming the
 * wrapper without renaming the route would be one more name for the same thing. What changed
 * is where it lands: the draft, so somebody sees what they are reinstating before it answers
 * a call.
 */
export const rollbackToVersion = async (agentId: string, version: number) =>
  (await api()).config.rollback({ path: { agentId, version } });

/** Unpublished work, or null. Read alongside the live configuration on every tab. */
export const readDraft = async (agentId: string) =>
  (await api()).config.readDraft({ path: { agentId } });

export type AgentDraft = NonNullable<Awaited<ReturnType<typeof readDraft>>["draft"]>;

/** Saves without making anything live. The whole document, as a publish is. */
export const saveDraft = async (agentId: string, body: DraftBody) =>
  (await api()).config.saveDraft({ path: { agentId }, body });

export const discardDraft = async (agentId: string) =>
  (await api()).config.discardDraft({ path: { agentId } });

export const listGuarantees = async (agentId: string) =>
  (await api()).config.listGuarantees({ path: { agentId } });

/**
 * Whether one agent is live, and what is missing if it is not.
 *
 * Per agent since the checks stopped guessing which one they were about. The report still
 * mixes two scopes — credentials, consent and event receivers are the organisation's — but
 * the number, greeting, voice, transfer target and traffic are this agent's, and reporting
 * another agent's is how a silent line looks wired.
 */
export const readinessReport = async (agentId: string) =>
  (await api()).readiness.report({ path: { agentId } });

/**
 * The voices the deployment's speech account can speak with.
 *
 * Not organisation data — the same answer for everyone, cached inside the API — but read
 * from the server like everything else here, because the ElevenLabs key lives there and the
 * browser has no session with anything except this app.
 */
export const listVoices = async () => (await api()).voices.list();

export type VoiceChoice = Awaited<ReturnType<typeof listVoices>>["voices"][number];

export const readTools = async () => (await api()).tools.read();

export type ToolsDocument = Awaited<ReturnType<typeof readTools>>;

/**
 * One GET against an endpoint, to see what shape it answers with.
 *
 * Server-side, like everything else here: the API enables no CORS, and the credential is
 * resolved inside the API from the vault — the browser never holds one.
 */
export const readKnowledge = async () => (await api()).knowledge.list();
export type KnowledgeDocument = Awaited<ReturnType<typeof readKnowledge>>;

export const createKnowledgeSource = async (body: {
  name: string;
  kind: "faq" | "table" | "document";
  units: readonly { question: string | null; body: string }[];
}) => (await api()).knowledge.create({ body: body as never });

export const readKnowledgeSource = async (sourceId: string) =>
  (await api()).knowledge.read({ path: { sourceId } });

export type KnowledgeSourceDetail = Awaited<ReturnType<typeof readKnowledgeSource>>;

export const replaceKnowledgeUnits = async (
  sourceId: string,
  expectedUpdatedAt: string,
  units: readonly { question: string | null; body: string }[],
) =>
  (await api()).knowledge.replaceUnits({
    path: { sourceId },
    body: { expectedUpdatedAt, units } as never,
  });

export const removeKnowledgeSource = async (sourceId: string) =>
  (await api()).knowledge.remove({ path: { sourceId } });

export const setAgentKnowledge = async (agentId: string, sources: readonly string[]) =>
  (await api()).agents.setKnowledge({ path: { agentId }, body: { sources: [...sources] } });

/** Run a tool that has not been saved, through the real dispatch path. */
export const tryTool = async (input: {
  tool: Record<string, unknown>;
  argumentsJson: string;
}) => (await api()).tools.try({ body: input as never });

export const sampleEndpoint = async (input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
  credentialRef?: string;
}) => (await api()).tools.sample({ body: input });

/**
 * The whole document, replaced.
 *
 * Typed from the generated client rather than from a hand-written copy: the copy existed
 * only to type this one call, and a second description of the request body is a second
 * thing to forget when the first changes.
 */
type ToolsBody = Parameters<Awaited<ReturnType<typeof api>>["tools"]["replace"]>[0]["body"];

export const replaceTools = async (
  expectedVersion: number,
  note: string | undefined,
  egress: ToolsBody["egress"],
  http: ToolsBody["http"],
  mcp: ToolsBody["mcp"],
) =>
  (await api()).tools.replace({
    body: { expectedVersion, note, egress, http, mcp },
  });

export const testTool = async (name: string, argumentsJson: string) =>
  (await api()).tools.test({ path: { name }, body: { argumentsJson } });

/**
 * Ring a number and let the live configuration answer it.
 *
 * Answers 202: queued with the carrier, not connected. Everything after that shows up on
 * the call itself, which is `/calls` — a page this feature does not own.
 */
export const placeTestCall = async (input: TestCallInput) =>
  (await api()).testCalls.place({ body: { to: input.to } });
