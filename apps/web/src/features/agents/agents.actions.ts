"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { failureMessage } from "@/lib/api/server";
import { failedForm, invalidForm, succeededForm, type FormState } from "@/lib/form-state";

import {
  httpToolBodySchema,
} from "./http-tool.schema";
import {
  capturedFieldsSchema,
  publishFormInput,
  publishSchema,
  testCallSchema,
  testToolSchema,
  toolsFormSchema,
  type CapturedField,
} from "./agents.schema";
import {
  createAgent,
  diffVersions,
  readTools,
  placeTestCall,
  setAgentFields,
  setAgentTools,
  updateAgent,
  publishConfiguration,
  replaceTools,
  rollbackToVersion,
  testTool,
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

export type PublishState = FormState<Published>;

export const publish = async (_previous: PublishState, form: FormData): Promise<PublishState> => {
  const parsed = publishSchema.safeParse(publishFormInput(form));
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const result = await publishConfiguration(parsed.data);
    revalidatePath("/agents", "layout");
    return succeededForm({ version: result.version.version, publishedAt: result.version.publishedAt });
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

export type RollbackState = FormState<Published>;

export const rollback = async (_previous: RollbackState, form: FormData): Promise<RollbackState> => {
  const version = Number(form.get("version"));
  const note = form.get("note");
  if (!Number.isInteger(version)) return failedForm("That is not a version number.");

  try {
    const result = await rollbackToVersion(version, typeof note === "string" && note !== "" ? note : undefined);
    revalidatePath("/agents", "layout");
    return succeededForm({ version: result.version.version, publishedAt: result.version.publishedAt });
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

export const replaceToolsAction = async (_previous: ToolsState, form: FormData): Promise<ToolsState> => {
  const parsed = toolsFormSchema.safeParse({
    expectedVersion: form.get("expectedVersion") ?? "",
    note: form.get("note") ?? undefined,
    allowedHosts: form.get("allowedHosts") ?? "",
    allowPlaintextHttp: form.get("allowPlaintextHttp") !== null,
    documentJson: form.get("documentJson") ?? "",
  });
  if (!parsed.success) return invalidForm(parsed.error);

  try {
    const { expectedVersion, note, allowedHosts, allowPlaintextHttp, documentJson } = parsed.data;
    const result = await replaceTools(
      expectedVersion,
      note,
      { allowedHosts, allowPlaintextHttp },
      documentJson.http,
      documentJson.mcp,
    );
    revalidatePath("/tools");
    revalidatePath("/agents", "layout");
    return succeededForm({ configVersion: result.configVersion }, "Tool registry published.");
  } catch (error) {
    return failedForm(failureMessage(error));
  }
};

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
export const getDiff = async (from: number, to: number): Promise<DiffResult> => {
  try {
    return { ok: true, diff: await diffVersions(from, to) };
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
 * Flip one of the agent's behaviour switches.
 *
 * Saved the moment it is flipped, and deliberately not through `publish`. A switch is an
 * operational control rather than a script change: it belongs to the agent row, not to the
 * versioned configuration document, so there is no note to write and no version to cut.
 * Making somebody publish to turn barge-in off would also mean they could not turn it off
 * without shipping whatever else they had half-typed into another tab.
 *
 * Returns the failure rather than throwing, so a refused write can put the switch back
 * where it was instead of leaving the UI claiming a state the database does not hold.
 */
export const setAgentBehaviour = async (
  agentId: string,
  change: { readonly bargeIn?: boolean; readonly answeringMachineDetection?: boolean },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  try {
    await updateAgent(agentId, change);
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
  // migration 0020.
  const switches = {
    ...(template.bargeIn ? {} : { bargeIn: false }),
    ...(template.answeringMachineDetection ? { answeringMachineDetection: true } : {}),
  };
  if (Object.keys(switches).length > 0) {
    try {
      await updateAgent(agentId, switches);
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

  try {
    const current = await readTools();
    const replacing = parsed.data.replacing === "" ? null : parsed.data.replacing;

    const http = [...(current.http as unknown as Record<string, unknown>[])];
    const at = replacing === null ? -1 : http.findIndex((entry) => entry["name"] === replacing);
    if (at === -1) http.push(tool);
    else http[at] = tool;

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
    return failedForm(failureMessage(error));
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
