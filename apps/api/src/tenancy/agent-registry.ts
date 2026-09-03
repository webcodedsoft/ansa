import {
  type AgentId,
  type BusinessHours,
  type HandoffDestination,
  type Logger,
  type OrganizationId,
} from "@ansa/shared";
import {
  listAgentKnowledgeSources,
  loadAgentForOrganization,
  loadAgentForNumber,
  withOrganization,
  type Db,
  type AgentConfig,
} from "@ansa/db";
import {
  CALL_CONTROL_DEFINITIONS,
  NO_CONNECTORS,
  NO_EVENTS,
  prepareConnectors,
  prepareEvents,
  type PreparedConnectors,
  type PreparedEvents,
} from "@ansa/tools";

import type { Flow } from "@ansa/shared";

import { knowledgeDefinitions } from "../orchestrator/knowledge";
import { composeSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../prompts/compose";
import { compileOrganizationLayer } from "../prompts/organization-layer";

import { parseCapturedFields, readStoredFlow, type CollectedField } from "./captured-fields";
import { BASE_KEYTERMS, MAX_KEYTERMS } from "./defaults";

/** Configuration as the call path sees it, with defaults already applied. */
export interface CallAgent {
  /** null when the dialled number is not registered, or config could not be read. */
  readonly organizationId: OrganizationId | null;
  /**
   * Which of the organisation's agents this number reaches (migration 0018).
   *
   * Null for an unregistered number, for the same reason `organizationId` is: nobody answered.
   * Recorded on the call, because `configVersion` no longer identifies a configuration on
   * its own — two agents are routinely both on version 3.
   */
  readonly agentId: AgentId | null;
  /** Whether a `search_knowledge_base` should be registered for this call. */
  readonly hasKnowledgeSources: boolean;
  readonly name: string;
  /** Base vocabulary merged with the organization's own (R4.1.3). */
  readonly keyterms: readonly string[];
  readonly voiceId: string | null;
  readonly speakingRate: number | null;
  readonly greeting: string | null;
  readonly persona: string | null;
  readonly instructions: string | null;
  /**
   * The five-layer system prompt with this organization's layer already in it.
   *
   * Composed here, once per config load, rather than per turn: the layers below the turn
   * budget do not change during a call, and the string is a couple of hundred tokens.
   * The turn layer is appended per turn by the orchestrator, which is how it works today
   * and is what proved the layering before the layering existed.
   */
  readonly systemPrompt: string;
  /** When their line is staffed, in WAT. Null until they configure it (R6.5). */
  readonly businessHours: BusinessHours | null;
  /**
   * Where this organisation's escalations go (R6.5). Null falls back to the platform's
   * own number, which is right for one organization and wrong for two — see migration 0015.
   */
  readonly handoff: HandoffDestination | null;
  /** Answers at any hour. Null when the organisation has not named one. */
  readonly crisisHandoff: HandoffDestination | null;
  /**
   * This organization's own tools, discovered and prepared once (R5.2).
   *
   * A function rather than a list because the registry is built per call: the platform
   * tools close over that call's own effects, so the organization's tools have to join them
   * there. Everything expensive — parsing, the egress guard, the vault, an MCP handshake —
   * already happened when this configuration was loaded.
   */
  readonly connectors: PreparedConnectors;
  /**
   * Where this organisation wants a record of the call pushed, and what it wants masked
   * on the way (Slice 6a). Empty for every organization until one configures a receiver.
   *
   * Prepared here beside the connectors because it needs the same three things — the
   * egress allowlist, the vault and the transport — and because resolving a signing secret
   * is not work to do while a call is ending.
   */
  readonly events: PreparedEvents;
  /** The caller may interrupt (migration 0020). The orchestrator reads this per call. */
  readonly bargeIn: boolean;
  /**
   * The form this agent conducts, parsed once at config load (migrations 0021, 0022).
   *
   * Parsed here rather than per call for the same reason the connectors are: it is the
   * same stored document, it must never throw, and the answer path should not be parsing
   * anything.
   */
  readonly capturedFields: readonly CollectedField[];
  /**
   * The graph this agent conducts, when it is drawn as one, parsed once at config load.
   *
   * Null covers three different things and deliberately does not distinguish them on the
   * answer path: the agent is a form, nobody has drawn a graph, or what was stored is not
   * one this build can walk. All three mean the same thing to a call — conduct it with the
   * list — and that is the reading that degrades into speech rather than into silence.
   */
  readonly flow: Flow | null;
  /** Outbound only: hang up on voicemail rather than talk to a greeting. */
  readonly answeringMachineDetection: boolean;
  /** Recorded on every call so a call from weeks ago can still be explained (R7.5). */
  readonly configVersion: number;
}

/**
 * What the model is told it can reach.
 *
 * Derived from the registered definitions rather than written out here, so the prompt
 * cannot describe a tool the registry does not hold — the list in `@ansa/tools` is the
 * single source of both. The organization's own tools are appended from what was actually
 * prepared, for the same reason: a tool whose MCP server was unreachable at config load is
 * not offered, rather than offered and then refused.
 */
const PLATFORM_TOOLS = CALL_CONTROL_DEFINITIONS.map((definition) => ({
  name: definition.name,
  description: definition.description,
  riskTier: definition.riskTier,
}));

/**
 * An unregistered number, and it keeps the empty tool list on purpose.
 *
 * `organizationId: null` disables tool dispatch outright, so a prompt listing tools here would
 * offer the model three things it would then be silently refused. The empty case tells it
 * the truth: on this call it cannot look anything up.
 */
export const UNKNOWN_AGENT: CallAgent = {
  organizationId: null,
  agentId: null,
  // Nobody answered, so there is no agent whose sources could be searched.
  hasKnowledgeSources: false,
  name: "unknown",
  keyterms: BASE_KEYTERMS,
  voiceId: null,
  speakingRate: null,
  greeting: null,
  persona: null,
  instructions: null,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  businessHours: null,
  handoff: null,
  crisisHandoff: null,
  connectors: NO_CONNECTORS,
  events: NO_EVENTS,
  // An unregistered number gets the pipeline's defaults; there is no agent to ask.
  bargeIn: true,
  answeringMachineDetection: false,
  // An unregistered number has no agent, so there is no form to conduct.
  capturedFields: [],
  flow: null,
  configVersion: 0,
};

const mergeKeyterms = (
  organization: readonly string[],
  log: Logger,
  organizationId: OrganizationId,
): readonly string[] => {
  // Base first: if the list has to be cut, the terms that fail on every call survive.
  const seen = new Map<string, string>();
  for (const term of [...BASE_KEYTERMS, ...organization]) {
    const trimmed = term.trim();
    // Deepgram takes one keyterm per query parameter. A comma-joined value is accepted
    // and then silently ignored, which cost an afternoon to find — so a term containing
    // one is dropped loudly rather than sent.
    if (trimmed === "" || trimmed.includes(",")) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }

  const merged = [...seen.values()];
  if (merged.length <= MAX_KEYTERMS) return merged;

  log.warn("keyterms truncated", {
    organizationId,
    requested: merged.length,
    cap: MAX_KEYTERMS,
    dropped: merged.slice(MAX_KEYTERMS),
  });
  return merged.slice(0, MAX_KEYTERMS);
};

/**
 * Config as stored, turned into config as the call path uses it.
 *
 * The prompt is composed here rather than at the call site for the same reason keyterms
 * are merged here: it is the one place that has the organization's stored values, and doing it
 * anywhere else means doing it twice and getting it different the second time.
 *
 * A organization's persona or instructions that try to weaken a §1 guarantee are dropped, and
 * the call proceeds on the remaining layers. Two deliberate choices in that sentence:
 *
 *   - dropped, not honoured. `compileOrganizationLayer` is the only way to produce the value
 *     `composeSystemPrompt` accepts, so this is not a check that could be forgotten at
 *     a call site — there is no other route in.
 *   - proceeds, not fails. A configuration problem must never become silence on the line
 *     (R6.2), and the guarantees hold in the dispatch paths regardless of what the prompt
 *     says, so the safe thing and the available thing are the same thing here.
 */
/**
 * Whether this agent has anything to search, resolved once with its configuration.
 *
 * A query rather than a column on `agent_config_for_number`, because it is a count over a
 * join and the registry caches the whole answer for ten minutes — so this costs one extra
 * round trip per configuration load, not one per call. It never throws: a knowledge lookup
 * that cannot be resolved leaves the tool unregistered, which is the same degradation
 * `prepareConnectors` makes for an unreachable endpoint (R6.2).
 */
const resolveKnowledge = async (
  dataSource: Db,
  config: AgentConfig,
  log: Logger,
): Promise<boolean> => {
  if (config.agentId === null) return false;
  const agentId = config.agentId;
  try {
    const sources = await withOrganization(dataSource, config.organizationId, (scope) =>
      listAgentKnowledgeSources(scope, agentId),
    );
    return sources.length > 0;
  } catch (error) {
    log.error("could not resolve knowledge sources; the agent will not offer a search", {
      organizationId: config.organizationId,
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
};

const toCallAgent = async (
  config: AgentConfig,
  log: Logger,
  credentialKey: Buffer | null,
  hasKnowledgeSources: boolean,
): Promise<CallAgent> => {
  const { layer, violations } = compileOrganizationLayer({
    name: config.name,
    persona: config.persona,
    instructions: config.instructions,
  });

  if (violations.length > 0) {
    // Loud, and with the version, because the fix is a new config version rather than a
    // code change and whoever published it needs to know which one to correct.
    log.error("organization config tried to weaken a guarantee; those fields were dropped", {
      organizationId: config.organizationId,
      configVersion: config.configVersion,
      violations,
    });
  }

  /* Parsed once per configuration load, beside the connectors and for the same reasons:
     it is the same kind of stored document, it must never throw, and doing it here means
     the prompt is composed from it without the call path parsing anything per turn. */
  const fields = parseCapturedFields(config.capturedFields, {
    agentId: config.agentId,
    log,
  });

  /* The graph, on the same terms as the form above: parsed once here, never on the answer
     path, and never throwing. */
  const flow = config.authoringMode === "flow" ? readStoredFlow(config.flow, config.agentId, log) : null;

  // Discovery and the MCP handshake happen here, once per configuration load, rather than
  // per call. `prepareConnectors` never throws: a organization whose endpoint is unreachable
  // gets fewer tools, never a failed call (R6.2).
  const connectors = await prepareConnectors({
    organizationId: config.organizationId,
    config: config.toolConfig,
    // The registry belongs to the organisation; this is the answering agent's slice of it
    // (migration 0018). Always passed on the call path, so an agent that has selected
    // nothing reaches nothing — never the whole registry by default.
    enabledTools: config.enabledTools,
    credentialKey,
    sealedCredentials: config.sealedCredentials,
    log,
  });

  // Same treatment and the same promise as the connectors: never throws, and a organization
  // whose event configuration is wrong gets no deliveries rather than a failed call.
  const events = await prepareEvents({
    organizationId: config.organizationId,
    config: config.eventConfig,
    credentialKey,
    sealedCredentials: config.sealedCredentials,
    log,
  });

  return {
    organizationId: config.organizationId,
    agentId: config.agentId,
    name: config.name,
    keyterms: mergeKeyterms(config.keyterms, log, config.organizationId),
    voiceId: config.voiceId,
    speakingRate: config.speakingRate,
    greeting: config.greeting,
    persona: config.persona,
    instructions: config.instructions,
    // The platform tools every registered organization gets, plus this organization's own. Both come
    // from what is actually registered, so the prompt cannot promise a lookup the
    // dispatcher would refuse.
    /* Knowledge sits with the platform tools rather than the organisation's, because it is
       one of ours: the registry builds it, not `prepareConnectors`. Listed only when the
       agent actually has sources, so the grounding instruction the task layer derives from
       this list appears on the same condition the tool does. */
    systemPrompt: composeSystemPrompt({
      organization: layer,
      tools: [
        ...PLATFORM_TOOLS,
        ...knowledgeDefinitions({ agentId: config.agentId, hasSources: hasKnowledgeSources }),
        ...connectors.tools,
      ],
      fields,
      policyBlocks: config.policyBlocks,
    }),
    hasKnowledgeSources,
    businessHours: config.businessHours,
    handoff: config.handoff,
    crisisHandoff: config.crisisHandoff,
    connectors,
    events,
    bargeIn: config.bargeIn,
    capturedFields: fields,
    flow,
    answeringMachineDetection: config.answeringMachineDetection,
    configVersion: config.configVersion,
  };
};

interface Entry {
  readonly organization: CallAgent;
  readonly expiresAt: number;
}

export interface AgentRegistryOptions {
  readonly dataSource: Db | null;
  readonly log: Logger;
  /** How long config is reused before it is read again. */
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** R5.2.1. Null disables every organization tool that needs a credential; see `env.ts`. */
  readonly credentialKey?: Buffer | null;
}

/**
 * Resolves a dialled number to its organization (R7.3) and caches the configuration.
 *
 * Two entry points on purpose:
 *
 *   resolve()  runs at the voice webhook, may hit the database, and is allowed to be slow.
 *   cached()   runs when the media socket opens and is synchronous.
 *
 * The split exists because the media socket is on the latency path and configuration is
 * not worth a database round trip there. Ingress warmed the cache moments earlier; if it
 * somehow did not, the call proceeds on defaults rather than waiting. Configuration
 * failing must never turn into silence on the line (R6.2).
 */
export const createAgentRegistry = (options: AgentRegistryOptions) => {
  const { dataSource, log } = options;
  const ttlMs = options.ttlMs ?? 600_000;
  const credentialKey = options.credentialKey ?? null;
  const now = options.now ?? Date.now;

  const byNumber = new Map<string, Entry>();
  const byOrganization = new Map<string, Entry>();

  const remember = (dialled: string, organization: CallAgent): CallAgent => {
    const entry = { organization, expiresAt: now() + ttlMs };
    byNumber.set(dialled, entry);
    if (organization.organizationId !== null) byOrganization.set(organization.organizationId, entry);
    return organization;
  };

  const fresh = (entry: Entry | undefined): CallAgent | null =>
    entry !== undefined && entry.expiresAt > now() ? entry.organization : null;

  return {
    resolve: async (dialled: string): Promise<CallAgent> => {
      const hit = fresh(byNumber.get(dialled));
      if (hit !== null) return hit;
      if (dataSource === null) return UNKNOWN_AGENT;

      try {
        const config = await loadAgentForNumber(dataSource, dialled);
        if (config === null) {
          log.warn("dialled number is not registered to a organization", { dialled });
          return remember(dialled, UNKNOWN_AGENT);
        }
        const knowledge = await resolveKnowledge(dataSource, config, log);
        return remember(dialled, await toCallAgent(config, log, credentialKey, knowledge));
      } catch (error) {
        // A database that is down must cost the caller a personalised greeting, not the
        // call. Deliberately not cached: retry on the next call rather than serving
        // defaults to a configured organization for a whole TTL.
        log.error("organization lookup failed, answering on defaults", {
          dialled,
          error: error instanceof Error ? error.message : String(error),
        });
        return UNKNOWN_AGENT;
      }
    },

    /** Synchronous read for the media socket. Null means "use defaults, do not wait". */
    cached: (organizationId: string): CallAgent | null => fresh(byOrganization.get(organizationId)),

    /**
     * Load configuration for a organization we already know, warming the cache.
     *
     * Outbound calls need this and inbound ones do not. Inbound resolves at the voice
     * webhook, which warms the cache a moment before the media socket opens. Outbound
     * inlines its TwiML at origination, so there is no webhook and nothing has ever
     * looked this organization up in this process — the id arrives on the socket already
     * known, with no configuration behind it.
     *
     * Found by the first outbound call: the organization travelled out and back correctly and
     * the agent still answered on base vocabulary.
     */
    load: async (organizationId: OrganizationId): Promise<CallAgent | null> => {
      const hit = fresh(byOrganization.get(organizationId));
      if (hit !== null) return hit;
      if (dataSource === null) return null;

      try {
        const config = await loadAgentForOrganization(dataSource, organizationId);
        if (config === null) {
          log.error("organization id on the media socket has no config", { organizationId });
          return null;
        }

        const knowledge = await resolveKnowledge(dataSource, config, log);
        const organization = await toCallAgent(config, log, credentialKey, knowledge);
        // Cached by id only: this call never had a dialled number to key on.
        byOrganization.set(organizationId, { organization, expiresAt: now() + ttlMs });
        return organization;
      } catch (error) {
        log.error("could not load organization config for an outbound call", {
          organizationId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
};

export type AgentRegistry = ReturnType<typeof createAgentRegistry>;
