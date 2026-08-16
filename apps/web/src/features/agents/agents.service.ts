import { api } from "@/lib/api/server";

import type { DraftBody, PublishBody, TestCallInput } from "./agents.schema";

/**
 * Everything this app does with the agent's configuration.
 *
 * The API has one configuration per organization, not one per agent — every function here reads
 * or writes that single document. `/agents/[agentId]` calls `currentConfiguration` no
 * matter what id is in the URL; see the comment there. Keeping every call in one file is
 * what stops the list page, the workspace and the wizard from disagreeing about the shape
 * of a configuration.
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

export const updateAgent = async (
  agentId: string,
  body: {
    readonly name?: string;
    readonly persona?: string | null;
    readonly instructions?: string | null;
    readonly dialledNumber?: string | null;
    readonly bargeIn?: boolean;
    readonly answeringMachineDetection?: boolean;
    /** Null is the voice's own pace, which is not the same as 1.0. */
    readonly speakingRate?: number | null;
  },
) => (await api()).agents.update({ path: { agentId }, body });

/** Retires the agent and releases its number. The API archives rather than deletes. */
export const archiveAgent = async (agentId: string) =>
  (await api()).agents.archive({ path: { agentId } });

/** The whole form, in order. Order is what the caller hears, so it is never patched. */
export const setAgentFields = async (agentId: string, fields: readonly unknown[]) =>
  (await api()).agents.setFields({ path: { agentId }, body: { fields: [...fields] } as never });

/** The whole selection, not a patch — what is on screen is what gets saved. */
export const setAgentTools = async (agentId: string, tools: readonly string[]) =>
  (await api()).agents.setTools({ path: { agentId }, body: { tools: [...tools] } });

export type AgentSummary = Awaited<ReturnType<typeof listAgents>>["items"][number];

export const currentConfiguration = async () => (await api()).config.current();

export type LiveConfiguration = Awaited<ReturnType<typeof currentConfiguration>>;

export const publishConfiguration = async (body: PublishBody) => {
  const result = await (await api()).config.publish({ body });
  return result;
};

export const listVersions = async (page?: number) =>
  (await api()).config.listVersions({
    query: { perPage: 25, ...(page === undefined ? {} : { page }) },
  });

export const getVersion = async (version: number) => (await api()).config.version({ path: { version } });

export const diffVersions = async (from: number, to: number) =>
  (await api()).config.diff({ query: { from, to } });

/**
 * Puts a published version back on screen. It does not publish it.
 *
 * Named `rollbackToVersion` still, because the route is still `rollback` and renaming the
 * wrapper without renaming the route would be one more name for the same thing. What changed
 * is where it lands: the draft, so somebody sees what they are reinstating before it answers
 * a call.
 */
export const rollbackToVersion = async (version: number) =>
  (await api()).config.rollback({ path: { version } });

/** Unpublished work, or null. Read alongside the live configuration on every tab. */
export const readDraft = async () => (await api()).config.readDraft();

export type AgentDraft = NonNullable<Awaited<ReturnType<typeof readDraft>>["draft"]>;

/** Saves without making anything live. The whole document, as a publish is. */
export const saveDraft = async (body: DraftBody) => (await api()).config.saveDraft({ body });

export const discardDraft = async () => (await api()).config.discardDraft();

export const listGuarantees = async () => (await api()).config.listGuarantees();

export const readinessReport = async () => (await api()).readiness.report();

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
