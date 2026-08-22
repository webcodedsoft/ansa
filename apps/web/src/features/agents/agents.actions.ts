"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import {
  httpToolBodySchema,
} from "./http-tool.schema";
import { knowledgeFormSchema } from "./knowledge.schema";
import {
  capturedFieldsSchema,
  draftSchema,
  publishFormInput,
  publishSchema,
  testCallSchema,
  testToolSchema,
  type CapturedField,
} from "./agents.schema";
import {
  createAgent,
  diffVersions,
  discardDraft,
  saveDraft,
  listVoices,
  readTools,
  createKnowledgeSource,
  readKnowledgeSource,
  removeKnowledgeSource,
  replaceKnowledgeUnits,
  setAgentKnowledge,
  sampleEndpoint,
  tryTool,
  placeTestCall,
  setAgentFields,
  setAgentTools,
  stageAgentBehaviour,
  publishConfiguration,
  replaceTools,
  rollbackToVersion,
  testTool,
  type VoiceChoice,
} from "./agents.service";
import { findTemplate } from "./templates";

/**
 * Server Actions for the agent workspace.
 *
 * Each one parses with the matching schema, sends, and revalidates the paths that read the
 * document it just changed. Revalidation matters here specifically because the workspace,
 * the list and the wizard all render the same single configuration — a publish from any one
 * of them has to be visible from the other two on the next request.
 */

export interface Published {
  readonly version: number;
  readonly publishedAt: string;
}

/**
 * Which agent this form is for.
 *
 * Carried as a hidden field rather than inferred, because a server action has no route to
 * read it from — it is called by the form, not by the page. Configuration used to need no
 * agent at all: the API resolved the organisation's oldest live agent, so every workspace
 * published into the same document whatever id was in the URL.
 *
 * A missing or malformed value fails the action rather than falling back to "the only agent".
 * A fallback here would restore exactly the behaviour this change exists to remove, and it
 * would do it silently on the one path that writes.
 */
const agentFrom = (form: FormData): string | null => {
  const value = form.get("agentId");
  return typeof value === "string" && UUID.test(value) ? value : null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublishState = FormState<Published>;

export const publish = async (_previous: PublishState, form: FormData): Promise<PublishState> => {
  const agentId = agentFrom(form);
  if (agentId === null) return failedForm("This form does not say which agent it is for.");
  const parsed = publishSchema.safeParse(publishFormInput(form));
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await publishConfiguration(agentId, parsed.data);
    revalidatePath("/agents", "layout");
    return succeededForm({ version: result.version.version, publishedAt: result.version.publishedAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Saving, which is not publishing.
 *
 * The same form and the same validation as a publish, minus the note and minus the effect.
 * Nothing a caller hears moves: the draft is a table no live read path consults, so a save
 * during a call changes nothing about that call or the next one.
 *
 * The whole document goes, not the fields somebody touched. `POST /config/versions` rewrites
 * rather than patches, so a partial draft would have to be merged against a live copy that
 * may have moved since — and the merge is where the wrong greeting goes out.
 */
export interface Saved {
  readonly updatedAt: string;
}

export type SaveDraftState = FormState<Saved>;

export const saveDraftAction = async (
  _previous: SaveDraftState,
  form: FormData,
): Promise<SaveDraftState> => {
  const agentId = agentFrom(form);
  if (agentId === null) return failedForm("This form does not say which agent it is for.");
  const parsed = draftSchema.safeParse(publishFormInput(form));
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await saveDraft(agentId, parsed.data);
    revalidatePath("/agents", "layout");
    return succeededForm({ updatedAt: result.updatedAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Throwing the unpublished work away.
 *
 * The first of the two ways back, and the one that leaves no trace: a draft nobody published
 * never answered a call, so recording it as a version would make the version list mean two
 * different things.
 */
export type DiscardDraftState = FormState<{ readonly discarded: boolean }>;

export const discardDraftAction = async (
  _previous: DiscardDraftState,
  form: FormData,
): Promise<DiscardDraftState> => {
  const agentId = agentFrom(form);
  if (agentId === null) return failedForm("This form does not say which agent it is for.");
  try {
    const result = await discardDraft(agentId);
    revalidatePath("/agents", "layout");
    return succeededForm({ discarded: result.discarded });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/** Restoring produces a draft, not a version, so it reports where the draft came from. */
export interface Restored {
  readonly restoredFrom: number;
  readonly updatedAt: string;
}

export type RollbackState = FormState<Restored>;

/**
 * Puts an old version back on screen, unpublished.
 *
 * It used to publish, which made the version list a second way to change a live call without
 * pressing Publish — the thing drafts exist to stop. What comes back is the draft, so the
 * page can say "loaded, review it and publish" rather than "done".
 */
export const rollback = async (_previous: RollbackState, form: FormData): Promise<RollbackState> => {
  const agentId = agentFrom(form);
  if (agentId === null) return failedForm("This form does not say which agent it is for.");
  const version = Number(form.get("version"));
  if (!Number.isInteger(version)) return failedForm("That is not a version number.");

  try {
    const restored = await rollbackToVersion(agentId, version);
    revalidatePath("/agents", "layout");
    return succeededForm({ restoredFrom: version, updatedAt: restored.updatedAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export interface TestCallPlaced {
  readonly carrierCallId: string;
  readonly status: string;
  readonly to: string;
}

export type TestCallState = FormState<TestCallPlaced>;

export const placeTestCallAction = async (_previous: TestCallState, form: FormData): Promise<TestCallState> => {
  const parsed = testCallSchema.safeParse({ to: form.get("to") ?? "" });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await placeTestCall(parsed.data);
    return succeededForm(
      { carrierCallId: result.carrierCallId, status: result.status, to: result.to },
      `Ringing ${result.to}. Answer it to hear this agent.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export interface ToolsPublished {
  readonly configVersion: number;
}

export type ToolsState = FormState<ToolsPublished>;

export interface ToolTestResult {
  readonly outcome: "ok" | "confirm" | "transfer" | "failed";
  readonly summary: string;
  readonly speech: string;
  readonly raw: string | null;
  readonly latencyMs: number;
}

export type DiffResult =
  | { readonly ok: true; readonly diff: Awaited<ReturnType<typeof diffVersions>> }
  | { readonly ok: false; readonly message: string };

/**
 * Called directly from a button, not through a form — there is nothing here for a person to
 * type, just two version numbers already on the page. Reports failure the same way a
 * `FormState` does (a message, not a thrown error crossing the client boundary), because a
 * client component cannot import `failureMessage` itself: it lives in `@/lib/api/server`,
 * which pulls in `next/headers` and cannot be bundled for the client.
 */
export const getDiff = async (agentId: string, from: number, to: number): Promise<DiffResult> => {
  try {
    return { ok: true, diff: await diffVersions(agentId, from, to) };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

export type VoiceCatalogueLoaded =
  | {
      readonly ok: true;
      readonly voices: readonly VoiceChoice[];
      /** The vendor's library did not answer. See the Voice tab for what it says about it. */
      readonly libraryUnread: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The voice list, fetched by the Voice tab rather than by the page.
 *
 * Called from a client component the way `getDiff` is, and for a stronger reason than that
 * one: the workspace is a client tree, so a Server Component cannot be dropped into it, and
 * loading the list on the page would put a vendor round trip in front of every tab —
 * Overview, Tools, Versions — none of which needs it. The list is cached in the API, so the
 * cost of asking here is a request rather than a fetch to ElevenLabs.
 *
 * Failure comes back as a message rather than a thrown error, so a tab whose picker cannot
 * load falls back to a plain id field instead of taking the workspace down with it.
 */
export const loadVoiceCatalogue = async (): Promise<VoiceCatalogueLoaded> => {
  try {
    const listing = await listVoices();
    return { ok: true, voices: listing.voices, libraryUnread: listing.libraryUnread };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

export type ToolTestState = FormState<ToolTestResult>;

export const testToolAction = async (_previous: ToolTestState, form: FormData): Promise<ToolTestState> => {
  const parsed = testToolSchema.safeParse({
    name: form.get("name") ?? "",
    argumentsJson: form.get("argumentsJson") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await testTool(parsed.data.name, parsed.data.argumentsJson);
    return succeededForm({
      outcome: result.outcome,
      summary: result.summary,
      speech: result.speech,
      raw: result.raw,
      latencyMs: result.latencyMs,
    });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/**
 * Stage one of the agent's behaviour switches.
 *
 * Saved the moment it is flipped and live on nothing until Publish, which is the same rule
 * every other per-agent setting follows since 0041. It used to write the agent row directly,
 * on the argument that a switch is an operational control rather than a script change — but
 * a caller cannot hear the difference between "the agent stopped letting me interrupt"
 * because somebody published and because somebody flipped a switch, and one of those two was
 * not going to appear in any version history.
 *
 * Only the switch that moved is sent. The other is left as it was, staged or live, so two
 * flips cannot revert each other through a value this page read when it rendered.
 *
 * Returns the failure rather than throwing, so a refused write can put the switch back
 * where it was instead of leaving the UI claiming a state the database does not hold.
 */
export const setAgentBehaviour = async (
  agentId: string,
  change: { readonly bargeIn?: boolean; readonly answeringMachineDetection?: boolean },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  try {
    await stageAgentBehaviour(agentId, change);
    revalidatePath("/agents", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

/**
 * Replace the voice form this agent conducts.
 *
 * Whole array, because the order is the order the caller is asked. Parsed here as well as
 * on the server: a field with an unusable key should say so beside the field, not arrive
 * back as a 422 about a request body.
 */
export const saveCapturedFields = async (
  agentId: string,
  fields: readonly CapturedField[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const parsed = capturedFieldsSchema.safeParse(fields);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, message: first?.message ?? "That form is not valid." };
  }

  try {
    await setAgentFields(agentId, parsed.data);
    revalidatePath("/agents", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

/**
 * The agent exists, and here is what did not make it.
 *
 * Deliberately not a plain success/failure. Creating an agent from a template is three
 * calls — the row, its form, its switches — and only the first of them is the agent. If the
 * form fails after the row is written, reporting failure would be a lie that leads somebody
 * to press Create again and end up with two agents. So the id comes back either way, and
 * the warning says what still needs doing on the page they are about to land on.
 */
export type AgentCreated =
  | { readonly ok: true; readonly agentId: string; readonly warning: string | null }
  | { readonly ok: false; readonly message: string };

const agentNameSchema = z
  .string()
  .trim()
  .min(1, "Give the agent a name.")
  .max(120, "That name is too long.");

/**
 * Create an agent from one of the starting points in `templates.ts`.
 *
 * Three calls rather than one, because the API models these as three things: the agent row,
 * the voice form it conducts, and the operational switches. That is the right split — a
 * switch is not a script change — and it means this function owns the ordering rather than
 * the endpoints owning a combined create nobody else would use.
 *
 * The template's instructions ride along on the create. They used to be left behind —
 * `POST /agents` did not accept them and the only endpoint that wrote them was
 * organisation-scoped, so applying them here would have put this template's house rules on
 * the organisation's *oldest* agent. Both endpoints take `instructions` now, so the agent
 * is complete when this returns and nothing has to be pasted in afterwards.
 */
export const createAgentFromTemplate = async (input: {
  readonly name: string;
  readonly templateId: string;
}): Promise<AgentCreated> => {
  const parsedName = agentNameSchema.safeParse(input.name);
  if (!parsedName.success) {
    const first = parsedName.error.issues[0];
    return { ok: false, message: first?.message ?? "That name is not usable." };
  }

  const template = findTemplate(input.templateId);
  if (template === null) return { ok: false, message: "That template no longer exists." };

  let agentId: string;
  try {
    const created = await createAgent({
      name: parsedName.data,
      persona: template.persona === "" ? null : template.persona,
      greeting: template.greeting === "" ? null : template.greeting,
      // Empty as null rather than "": a blank template should leave the agent with no
      // rules, and an empty string in the prompt layer is a fence around nothing.
      instructions: template.instructions === "" ? null : template.instructions,
    });
    agentId = created.agentId;
  } catch (error) {
    // Nothing was written, so this one really is a failure and pressing Create again is
    // the right thing to do.
    return { ok: false, message: failureMessage(error) };
  }

  const unfinished: string[] = [];

  if (template.fields.length > 0) {
    try {
      await setAgentFields(agentId, template.fields);
    } catch (error) {
      unfinished.push(`its form (${failureMessage(error)})`);
    }
  }

  // Only when the template disagrees with what a new agent already gets, so the common case
  // costs no request at all. Barge-in defaults on and detection defaults off — see
  // migration 0020. Staged rather than applied since 0041, exactly as the template's form
  // above is: a new agent from a template opens with unpublished changes, which is the
  // honest description of a template nobody has published yet.
  const switches = {
    ...(template.bargeIn ? {} : { bargeIn: false }),
    ...(template.answeringMachineDetection ? { answeringMachineDetection: true } : {}),
  };
  if (Object.keys(switches).length > 0) {
    try {
      await stageAgentBehaviour(agentId, switches);
    } catch (error) {
      unfinished.push(`its switches (${failureMessage(error)})`);
    }
  }

  revalidatePath("/agents", "layout");

  return {
    ok: true,
    agentId,
    warning:
      unfinished.length === 0
        ? null
        : `The agent was created, but ${unfinished.join(" and ")} did not save. Set that up on its own page.`,
  };
};

/**
 * Replace which of the organisation's tools this agent may call.
 *
 * The registry belongs to the organisation and this is one agent's slice of it, so the
 * whole selection is sent rather than a diff — what is on screen is what gets stored.
 *
 * Not a publish, and not versioned. Revoking a tool is an operational act that should take
 * effect on the next call without shipping whatever else is half-written on another tab,
 * which is the same argument the behaviour switches make.
 */
export const saveAgentTools = async (
  agentId: string,
  tools: readonly string[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  try {
    await setAgentTools(agentId, tools);
    revalidatePath("/agents", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};


/**
 * Save one HTTP tool into the organisation's document.
 *
 * `PUT /tools` replaces the whole document, so this reads the current one, swaps a single
 * entry and writes it back. Three things about that are load-bearing:
 *
 * - **The MCP section round-trips untouched.** The console has no editor for it, and a save
 *   that dropped what it could not display would delete a working integration.
 * - **The host is added to the egress allowlist.** Forgetting it is the failure that costs
 *   the most and shows the least: the tool registers, the model is told it can use it, and
 *   every call answers "sorry, I couldn't get that just now". No screen ever said why.
 * - **`replacing` is separate from the new name**, so renaming a tool edits it in place
 *   rather than leaving the old one behind beside its replacement.
 *
 * `expectedVersion` still decides the race. Two people with the tools page open is ordinary,
 * and the loser hears about it rather than finding their tool gone next week.
 */
export const saveHttpToolAction = async (
  _previous: ToolsState,
  form: FormData,
): Promise<ToolsState> => {
  const parsed = httpToolBodySchema.safeParse({
    expectedVersion: form.get("expectedVersion") ?? "",
    tool: form.get("tool") ?? "",
    replacing: form.get("replacing") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  let tool: Record<string, unknown>;
  try {
    tool = JSON.parse(parsed.data.tool) as Record<string, unknown>;
  } catch {
    return failedForm("The form could not be read. Reload the page and try again.");
  }

  /**
   * Where this tool sits in the registry, for naming a refusal about it.
   *
   * `PUT /tools` validates the whole document, so a form editing one tool is told about
   * `http.1.name` — and the operator is looking at a page headed "Add a tool", not at a
   * numbered list. Knowing the index lets the message drop it. Declared out here because it
   * is worked out inside the `try` and needed inside the `catch`.
   */
  let savedAt: number | null = null;

  try {
    const current = await readTools();
    const replacing = parsed.data.replacing === "" ? null : parsed.data.replacing;

    const http = [...(current.http as unknown as Record<string, unknown>[])];
    const at = replacing === null ? -1 : http.findIndex((entry) => entry["name"] === replacing);
    if (at === -1) http.push(tool);
    else http[at] = tool;
    savedAt = at === -1 ? http.length - 1 : at;

    let host: string | null = null;
    try {
      host = new URL(String(tool["url"]).replace(/\{[^}]+\}/g, "_")).hostname;
    } catch {
      // The API refuses a malformed URL with a better message than this action could write.
      host = null;
    }
    const allowedHosts = [...current.egress.allowedHosts];
    if (host !== null && !allowedHosts.includes(host)) allowedHosts.push(host);

    const result = await replaceTools(
      parsed.data.expectedVersion,
      `dashboard: saved ${String(tool["name"])}`,
      { allowedHosts, allowPlaintextHttp: current.egress.allowPlaintextHttp },
      http as never,
      current.mcp as never,
    );

    revalidatePath("/tools");
    revalidatePath("/agents", "layout");
    return succeededForm(
      { configVersion: result.configVersion },
      `Saved ${String(tool["name"])}.`,
    );
  } catch (error) {
    /* Only this tool's index is dropped. A refusal about a different one keeps its number,
       because that is the case where the operator has to be told which. */
    return failedForm(failureMessage(error, savedAt === null ? {} : { within: `http.${savedAt}` }));
  }
};

/** Remove one HTTP tool. The MCP section and every other tool round-trip untouched. */
export const deleteHttpToolAction = async (
  _previous: ToolsState,
  form: FormData,
): Promise<ToolsState> => {
  const name = String(form.get("name") ?? "");
  const expectedVersion = Number(form.get("expectedVersion") ?? Number.NaN);
  if (name === "" || !Number.isInteger(expectedVersion)) {
    return failedForm("The form could not be read. Reload the page and try again.");
  }

  try {
    const current = await readTools();
    const http = (current.http as unknown as Record<string, unknown>[]).filter(
      (entry) => entry["name"] !== name,
    );

    /* The allowlist is left alone. Another tool may share the host, and working out whether
       one does is a judgement about hosts rather than about this tool — an entry nothing
       points at costs nothing, and removing one somebody still needs breaks a call. */
    const result = await replaceTools(
      expectedVersion,
      `dashboard: removed ${name}`,
      current.egress,
      http as never,
      current.mcp as never,
    );

    revalidatePath("/tools");
    revalidatePath("/agents", "layout");
    return succeededForm({ configVersion: result.configVersion }, `Removed ${name}.`);
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};


export interface SampleSeen {
  readonly status: number | null;
  /** The body as JSON text. Parsed in the component, which is where it is rendered. */
  readonly json: string | null;
  readonly detail: string | null;
}

export type SampleState = FormState<SampleSeen>;

/**
 * Fetch one response from an endpoint so the speech template can be written against it.
 *
 * The whole point is the failure it prevents: a template naming a field the response does
 * not have renders its fallback, and on a call that sounds exactly like the customer having
 * no record — not like a typo in a form nobody has looked at since.
 *
 * Every guard lives in the API. This carries the URL across and hands back what came back.
 */
export const sampleEndpointAction = async (
  _previous: SampleState,
  form: FormData,
): Promise<SampleState> => {
  const url = String(form.get("url") ?? "").trim();
  if (url === "") return failedForm("Enter a URL first.");

  const credentialRef = String(form.get("credentialRef") ?? "");

  /* Malformed headers become none rather than a refusal. They are the operator's own rows,
     already checked on the client, and failing the preview over them would report the wrong
     problem — the API refuses an unusable header name on save, which is where it matters. */
  const readHeaders = (): Record<string, string> => {
    try {
      return JSON.parse(String(form.get("headers") ?? "{}")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const headers = readHeaders();

  try {
    const result = await sampleEndpoint({
      url,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(credentialRef === "" ? {} : { credentialRef }),
    });

    // `ok: false` is the guard refusing, and it arrives as a 200 with a reason rather than
    // as an error — the reason is the useful part and belongs on the screen, not in a stack.
    if (!result.ok) return failedForm(result.detail ?? "The request was refused.");

    return succeededForm(
      { status: result.status, json: result.json, detail: result.detail },
      `Endpoint answered ${result.status ?? ""}.`.trim(),
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};


/**
 * Run the tool as it stands on screen, without saving it first.
 *
 * Waiting for a save meant publishing a configuration version to find out whether the thing
 * worked, and publishing another to fix it — so the version history filled with attempts
 * rather than decisions, and every attempt was live on the phone line in between.
 *
 * Nothing is stored. The risk tiers still hold, because they belong to the dispatcher and
 * not to this route: a write answers `confirm` without firing, an irreversible one answers
 * `transfer` and never runs at all.
 */
export const tryToolAction = async (
  _previous: ToolTestState,
  form: FormData,
): Promise<ToolTestState> => {
  let tool: Record<string, unknown>;
  try {
    tool = JSON.parse(String(form.get("tool") ?? "")) as Record<string, unknown>;
  } catch {
    return failedForm("The form could not be read. Reload the page and try again.");
  }

  const argumentsJson = String(form.get("argsJson") ?? "").trim();
  try {
    JSON.parse(argumentsJson);
  } catch {
    return failedForm("The arguments must be a JSON object.");
  }

  try {
    const result = await tryTool({ tool, argumentsJson });
    return succeededForm(
      {
        outcome: result.outcome,
        summary: result.summary,
        speech: result.speech,
        raw: result.raw,
        latencyMs: result.latencyMs,
      },
      `Ran ${String(tool["name"])}.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};


export type KnowledgeState = FormState<{ readonly sourceId: string }>;

/**
 * Store a source, already split into the pieces retrieval will return.
 *
 * The units arrive parsed because the operator has just seen them in a preview — what was
 * on screen is what is saved, rather than something a server-side splitter produced from
 * the same paste and might have split differently.
 *
 * Creating a source deliberately does not give it to any agent. Writing a FAQ should not
 * change what a live line says; that takes a second, explicit action.
 */
export const saveKnowledgeSourceAction = async (
  _previous: KnowledgeState,
  form: FormData,
): Promise<KnowledgeState> => {
  const parsed = knowledgeFormSchema.safeParse({
    name: form.get("name") ?? "",
    kind: form.get("kind") ?? "faq",
    unitsJson: form.get("unitsJson") ?? "[]",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  let units: { question: string | null; body: string }[];
  try {
    units = JSON.parse(parsed.data.unitsJson) as { question: string | null; body: string }[];
  } catch {
    return failedForm("The form could not be read. Reload the page and try again.");
  }
  if (units.length === 0) return failedForm("There is nothing to store.");

  try {
    const created = await createKnowledgeSource({
      name: parsed.data.name,
      kind: parsed.data.kind,
      units,
    });
    revalidatePath("/agents", "layout");
    return succeededForm(
      { sourceId: created.sourceId },
      `Stored ${created.name} — ${created.unitCount} piece${created.unitCount === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/** Retire a source. Retrieval stops for every agent using it, on the next call. */
export const removeKnowledgeSourceAction = async (
  _previous: KnowledgeState,
  form: FormData,
): Promise<KnowledgeState> => {
  const sourceId = String(form.get("sourceId") ?? "");
  if (sourceId === "") return failedForm("The form could not be read.");

  try {
    await removeKnowledgeSource(sourceId);
    revalidatePath("/agents", "layout");
    return succeededForm({ sourceId }, "Source retired.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

/** Which of the organisation's sources this agent may answer from. */
export const saveAgentKnowledgeAction = async (
  _previous: KnowledgeState,
  form: FormData,
): Promise<KnowledgeState> => {
  const agentId = String(form.get("agentId") ?? "");
  const sources = form.getAll("sources").map(String);
  if (agentId === "") return failedForm("The form could not be read.");

  try {
    await setAgentKnowledge(agentId, sources);
    revalidatePath("/agents", "layout");
    return succeededForm(
      { sourceId: agentId },
      sources.length === 0
        ? "This agent now answers from nothing — it will say it does not know."
        : `This agent answers from ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};




export type SourceUnits =
  | { readonly ok: true; readonly detail: Awaited<ReturnType<typeof readKnowledgeSource>> }
  | { readonly ok: false; readonly message: string };

/**
 * The pieces a source holds, loaded when somebody opens it.
 *
 * Not fetched with the list: a source can hold two thousand units, and the tab exists mostly
 * to tick which sources an agent uses. Loading every unit of every source to render a count
 * would make the common case pay for the rare one.
 */
export const loadKnowledgeUnits = async (sourceId: string): Promise<SourceUnits> => {
  try {
    return { ok: true, detail: await readKnowledgeSource(sourceId) };
  } catch (error) {
    return { ok: false, message: failureMessage(error) };
  }
};

/**
 * Replace what a source holds.
 *
 * `expectedUpdatedAt` is the source as it was when the editor opened. Two people with the
 * same page open is ordinary, and a source is shared by every agent using it — so the loser
 * of that race is told to re-read rather than silently overwriting what a colleague just
 * published to several live lines.
 */
export const saveKnowledgeUnitsAction = async (
  _previous: KnowledgeState,
  form: FormData,
): Promise<KnowledgeState> => {
  const sourceId = String(form.get("sourceId") ?? "");
  const expectedUpdatedAt = String(form.get("expectedUpdatedAt") ?? "");
  if (sourceId === "" || expectedUpdatedAt === "") {
    return failedForm("The form could not be read. Reload the page and try again.");
  }

  let units: { question: string | null; body: string }[];
  try {
    units = JSON.parse(String(form.get("unitsJson") ?? "[]")) as {
      question: string | null;
      body: string;
    }[];
  } catch {
    return failedForm("The form could not be read. Reload the page and try again.");
  }

  /* An empty source is not an error the API refuses, and it is almost never what somebody
     meant — retrieval would match nothing and the agent would say it does not know, which
     looks identical to the source having been deleted. Retiring it says that on purpose. */
  if (units.length === 0) {
    return failedForm(
      "A source with nothing in it retrieves nothing. Retire it instead, which says so plainly.",
    );
  }

  try {
    const saved = await replaceKnowledgeUnits(sourceId, expectedUpdatedAt, units);
    revalidatePath("/agents", "layout");
    return succeededForm(
      { sourceId },
      `Saved ${saved.unitCount} piece${saved.unitCount === 1 ? "" : "s"}.`,
    );
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};
