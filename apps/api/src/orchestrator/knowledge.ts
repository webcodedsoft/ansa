import type { AgentId, OrganizationId } from "@ansa/shared";
import type { AdapterCall, InternalTool, ToolArgs, ToolDefinition } from "@ansa/tools";

/**
 * The one tool that lets the agent answer a question about the organisation, and the
 * refusal that comes with it.
 *
 * `internal/call-control.ts` says why no lookup tool shipped before this one: an agent
 * answering confidently from a fixture nobody wrote is worse than one that says it cannot
 * check. A knowledge base is the first thing that answers that objection, because
 * somebody at the organisation did write it. What it does not do on its own is stop the
 * model answering from everything else it knows — a caller asking what a delivery costs
 * gets a number that is right for most Lagos couriers and wrong for this one, and nothing
 * on the call distinguishes the two. So the retrieval and the grounding instruction ship
 * together: the passages here, the instruction in `prompts/task-layer.ts`, composed only
 * when this tool is registered.
 *
 * There is no adapter in this file. `registerInternalTools` already has the only one an
 * internal tool needs, and a second would be the second dispatch path R5.2.0 exists to
 * prevent.
 */

/* ------------------------------------------------------------------ the seam */

/**
 * One retrieved passage, field for field the same as `KnowledgeHit` in `@ansa/db`.
 *
 * Declared here rather than imported because `@ansa/db` is consumed from its build output
 * and this module has to compile before the storage layer has been built once. Delete it
 * and import the real one the moment that stops being true — the shapes are identical and
 * a second copy of a type is a second thing to keep in step.
 */
export interface KnowledgeHit {
  readonly sourceId: string;
  readonly sourceName: string;
  /** The question this passage answers, when the source was written as a Q and A. */
  readonly question: string | null;
  readonly body: string;
  /** The store's own ordering. Read below for why nothing here re-sorts on it. */
  readonly rank: number;
}

/**
 * How this module reaches the store, and the only thing it knows about storage.
 *
 * Deliberately not `@ansa/db`'s own signature. That one takes a `OrganizationScope`, which is a
 * transaction handle, and holding one here would make this module the second place in the
 * call path that owns a database connection. The wiring closes over `withOrganization` and
 * hands us a function, so this file is unit-testable against a fake and the RLS scope is
 * opened by the layer that already knows how.
 *
 * `organizationId` is a parameter rather than a captured value because the dispatcher supplies
 * it per call (CLAUDE.md rule 3), and the authoritative one is the call's, not one this
 * module snapshotted at construction.
 *
 * No `AbortSignal`, because the agreed contract has none. The dispatcher races the hard
 * ceiling either way, so the caller never waits past it; what a signal would buy is
 * releasing the query server-side when it does, and that is the wiring's to add when
 * `searchKnowledge` grows one.
 */
export type SearchKnowledge = (
  organizationId: OrganizationId,
  agentId: AgentId,
  query: string,
  limit: number,
) => Promise<readonly KnowledgeHit[]>;

/** Whether this agent has anything to search — resolved with its configuration, at ingress. */
export interface KnowledgeAvailability {
  /** Null for an unregistered number. Nobody answered, so there are no sources to read. */
  readonly agentId: AgentId | null;
  /**
   * False when this agent has no knowledge sources attached.
   *
   * Not "has an empty knowledge base": the tool is not registered at all, so the model is
   * never told it can search and the task layer never mentions one. An agent offered a
   * search that can only ever come back empty spends a turn and three seconds finding
   * that out, on every question.
   */
  readonly hasSources: boolean;
}

export interface KnowledgeOptions extends KnowledgeAvailability {
  readonly search: SearchKnowledge;
  /** Overridden in tests. Never raises the ceiling below. */
  readonly limit?: number;
}

/* ------------------------------------------------------------------ bounds */

/**
 * Three passages, and the number is a conversation decision rather than a retrieval one.
 *
 * The turn the model then writes is two sentences and the whole tool call has three
 * seconds. Ten passages buys a longer prompt, a slower turn and a model choosing which of
 * ten things to say — which on a phone line reads as a rambling answer, not a thorough
 * one. Three is enough for the near-miss cases where the best hit is second.
 */
export const MAX_PASSAGES = 3;

/**
 * A knowledge row holds whatever its author pasted in, which can be a page.
 *
 * Cut at the last sentence that fits rather than mid-clause: a model handed half a
 * sentence finishes it, and finishing it is exactly the invention this tool exists to
 * stop. A passage with no sentence end inside the cap falls back to a word boundary.
 */
const MAX_PASSAGE_CHARS = 400;

/** The model writes this from what a caller said, so it is input rather than data. */
const MAX_QUERY_CHARS = 300;

const shorten = (body: string): string => {
  const text = body.trim().replace(/\s+/g, " ");
  if (text.length <= MAX_PASSAGE_CHARS) return text;

  const window = text.slice(0, MAX_PASSAGE_CHARS);
  const sentence = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("? "),
    window.lastIndexOf("! "),
  );
  if (sentence > 0) return window.slice(0, sentence + 1);

  const word = window.lastIndexOf(" ");
  return word > 0 ? window.slice(0, word) : window;
};

/**
 * Arguments come from a language model. A bad one throws and the dispatcher turns it into
 * a spoken apology rather than a crash — the same bargain `internal/policy.ts` makes.
 */
const requireQuery = (args: ToolArgs): string => {
  const value = args.query;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("search_knowledge_base needs a query and did not get one");
  }
  return value.trim().slice(0, MAX_QUERY_CHARS);
};

/* ------------------------------------------------------------------ speech */

/** What the handler produces. Turned into a sentence by `summarise`, never spoken raw. */
export interface Passage {
  /**
   * Which source answered. Never spoken — a source name is a file name — and kept for the
   * two readers that are not the caller: whoever reads the call back, and the retrieval
   * bookkeeping the wiring writes from the dispatcher's `onResult`, which needs the id.
   */
  readonly sourceId: string;
  readonly sourceName: string;
  readonly question: string | null;
  readonly body: string;
}

export interface Retrieval {
  readonly query: string;
  readonly passages: readonly Passage[];
}

const passageOf = (hit: KnowledgeHit): Passage => ({
  sourceId: hit.sourceId,
  sourceName: hit.sourceName,
  question: hit.question === null || hit.question.trim() === "" ? null : hit.question.trim(),
  body: shorten(hit.body),
});

const asSentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The question leads, when the source has one.
 *
 * It costs a few words and it tells the model which of the three passages answers what.
 * Without it three paragraphs arrive as one undifferentiated block and the model picks
 * the first.
 */
const sayPassage = (passage: Passage): string =>
  passage.question === null
    ? asSentence(passage.body)
    : `${asSentence(passage.question)} ${asSentence(passage.body)}`;

/**
 * Retrieval came back empty, and this sentence is the entire product requirement in one
 * line.
 *
 * It is an answer, not a failure: the tool worked and there is nothing on file. Said
 * plainly it becomes "I don't have that, let me put you through"; left as silence or as a
 * dispatcher error it becomes the model's own guess in the next sentence.
 */
const NOTHING_FOUND = "I don't have anything on file about that.";

const sayRetrieval = (retrieval: Retrieval): string => {
  if (retrieval.passages.length === 0) return NOTHING_FOUND;
  // The lead-in marks where the organisation's words start. `dispatch.ts` hands this
  // string to the model as what the tool returned, and the boundary between what was
  // retrieved and what the model already believed is the one it has to keep.
  return `From what's on file. ${retrieval.passages.map(sayPassage).join(" ")}`;
};

const isRetrieval = (value: unknown): value is Retrieval =>
  value !== null &&
  typeof value === "object" &&
  "passages" in value &&
  Array.isArray((value as Retrieval).passages);

/* ------------------------------------------------------------------ the tool */

/** The name the model asks for, and the one the task layer keys its grounding off. */
export const KNOWLEDGE_TOOL_NAME = "search_knowledge_base";

/**
 * `read` tier: it reads the organisation's own published answers and changes nothing.
 *
 * No `agentId` parameter, and that absence is the isolation. Which sources this call may
 * read was decided when the dialled number resolved an agent; taking it from the model's
 * arguments would let a caller's phrasing choose whose knowledge base to open.
 */
const SEARCH_KNOWLEDGE_BASE: ToolDefinition = {
  name: KNOWLEDGE_TOOL_NAME,
  description:
    "Search what the organisation has written down — services, prices, rules, locations — and answer only from what comes back.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What the caller asked, in their own words. A phrase, not a list of keywords.",
      },
    },
    required: ["query"],
  },
  riskTier: "read",
  summarise: (result) => (isRetrieval(result) ? sayRetrieval(result) : NOTHING_FOUND),
};

/**
 * Whether this call has a knowledge base at all.
 *
 * A predicate rather than two comparisons at each call site, because the answer is needed
 * in two places that must not disagree — here, deciding whether to register, and in the
 * prompt, deciding whether to tell the model to ground itself.
 */
export const hasKnowledge = (
  availability: KnowledgeAvailability,
): availability is KnowledgeAvailability & { readonly agentId: AgentId } =>
  availability.agentId !== null && availability.hasSources;

/**
 * The definition, when there is one.
 *
 * Exported for the same reason `CALL_CONTROL_DEFINITIONS` is: the prompt lists what is
 * registered without building a registry, and both come from this list, so the model
 * cannot be offered a search the registry does not hold or grounded in one it does.
 */
export const knowledgeDefinitions = (
  availability: KnowledgeAvailability,
): readonly ToolDefinition[] => (hasKnowledge(availability) ? [SEARCH_KNOWLEDGE_BASE] : []);

export const knowledgeTools = (options: KnowledgeOptions): readonly InternalTool[] => {
  if (!hasKnowledge(options)) return [];

  const { agentId, search } = options;
  const limit = Math.min(Math.max(1, options.limit ?? MAX_PASSAGES), MAX_PASSAGES);

  const handler = async ({ organizationId, args }: AdapterCall): Promise<Retrieval> => {
    const query = requireQuery(args);
    const hits = await search(organizationId, agentId, query, limit);

    return {
      query,
      /* Bounded again, having already asked for `limit`. A store that ignores the argument
         — or a fake in a test that does — would otherwise put ten passages into a turn
         with room for two sentences, and the model would answer from all ten.

         Taken in the order the store returned them. `rank` is the store's own score and
         re-sorting on it here would be this module guessing which direction it runs. */
      passages: hits.slice(0, limit).map(passageOf),
    };
  };

  return knowledgeDefinitions(options).map((definition) => ({ definition, handler }));
};
