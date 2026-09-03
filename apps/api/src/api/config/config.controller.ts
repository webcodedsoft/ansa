import {
  applyAgentBehaviour,
  applyAgentFlow,
  applyCapturedFields,
  discardAgentDraft,
  listAgentConfigVersions,
  loadAgentDraft,
  loadDraftFlow,
  loadPublishedFlow,
  loadConfigVersionForCall,
  loadCurrentAgentConfig,
  loadAgentConfigVersion,
  publishAgentConfig,
  saveAgentDraft,
  setAgentKnowledgeSources,
  setAgentTools,
  type AgentDraft,
  type ConfigVersion,
  type AgentConfigFields,
} from "@ansa/db";
import { Controller, Delete, Get, Inject, NotFoundException, Post, Put } from "@nestjs/common";

import { LIMITS } from "../../prompts/organization-layer";
import { BASE_KEYTERMS, MAX_KEYTERMS } from "../../tenancy/defaults";
import { Endpoint } from "../http/endpoint";
import { pageQuery, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { ValidationFailed } from "../http/problem";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import {
  flag,
  integer,
  list,
  nullable,
  optional,
  number,
  object,
  text,
  type Infer,
} from "../http/schema";
import {
  capturedField,
  MAX_CAPTURED_FIELDS,
  phoneNumber,
  timestamp,
  uuid,
} from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

import { diffConfigurations } from "./diff";
import {
  effectiveKeyterms,
  flowPublicationProblems,
  publicationProblems,
  publishedGuarantees,
} from "./publication";

/**
 * The agent's configuration: what it says, how it sounds, what it listens for, and every
 * version of that there has ever been.
 *
 * Three things shape this surface, and none of them is "expose the columns".
 *
 * **Versioning is the interface, not an implementation detail.** `agent_prompt_versions` is
 * append-only, `app.publish_agent_config` bumps and snapshots in one statement, and every
 * call records the version that served it. Hiding that behind a `PATCH /config` would throw
 * away the only thing that makes R7.5 answerable, so a change is a POST that creates a
 * version, a version has a URL, and a call can be handed back the configuration it ran on.
 *
 * **A publication is whole, and every field is required.** That is not pedantry: the publish
 * function writes what it is given and nulls what it is not, so a body with `greeting`
 * missing is a body that deletes the greeting. Making the field required turns "I forgot"
 * into a 422 rather than into a caller hearing a different first sentence tomorrow.
 *
 * **What a organization cannot set has no slot to set it in.** The operator's columns come back on
 * `GET /config` and appear nowhere in the request body, so an attempt to send one is a 422
 * from the schema layer rather than a rule somebody has to enforce. `GET /config/guarantees`
 * serves the rest of the §1 table from the code that enforces it.
 */

/**
 * Two more things this surface does, both of which fall out of the append-only table rather
 * than needing anything added to it.
 *
 * **A diff, because the question is always "it was working yesterday".** On a voice agent
 * the regression was *heard*, so the reader is looking for the sentence that changed and
 * not for a shape difference between two JSON documents. `diff.ts` does the comparison and
 * is pure.
 *
 * **A rollback is a publish, not an undo.** It reads an old version and publishes its
 * content as a new one, through `publishAgentConfig` and after the same
 * `publicationProblems` a hand-written publication faces. Nothing rewrites history, and
 * that is the whole reason a call from three weeks ago can still be explained (R7.5): the
 * version it recorded still says what the agent was actually working from. It also means a
 * version that was valid under yesterday's rules and is not valid today is refused rather
 * than quietly restored — a rollback that could route around a guarantee check would be a
 * second publish path, which is the thing this file has one of.
 */

/**
 * A greeting is the first sentence of a call and a voice id is an identifier at the TTS
 * account. Neither has a platform limit — the call path will say whatever is stored — so
 * these are bounds on the request, chosen so an unbounded string cannot arrive at a write
 * endpoint, and not claims about what the agent can hold.
 */
const MAX_GREETING_CHARS = 500;
const MAX_VOICE_ID_CHARS = 200;
const MAX_KEYTERM_CHARS = 100;
/** A version note is a sentence about why, not the change itself. */
const MAX_NOTE_CHARS = 500;

/**
 * All three or none, which the object shape says by itself: a nullable object whose three
 * properties are all required cannot express two thirds of a window. Migration 0012 refuses
 * the same thing at the other end, and additionally refuses a window that wraps past
 * midnight — `22 to 2` is either a night shift or a typo and the row cannot tell you which.
 */
/** Both numbers or neither, for the same structural reason, and matching migration 0015. */
const escalation = object({
  toNumber: phoneNumber(),
  fromNumber: phoneNumber(),
  /** Null takes the platform's ring time rather than storing a guess. */
  ringSeconds: nullable(integer({ minimum: 5, maximum: 120 })),
});

/**
 * The fields a publication is made of.
 *
 * The character limits on `name`, `persona` and `instructions` are `prompts/organization-layer.ts`'s
 * own, imported rather than repeated. Text past them is silently clamped on the way into the
 * prompt, so accepting a longer value here would store something the agent never reads.
 */
/** A heading, not a sentence. */
const MAX_POLICY_NAME_CHARS = 60;
/** One rule, said once. Longer than this is prose, which `instructions` already holds. */
const MAX_POLICY_LINE_CHARS = 200;
/** Enough to be useful, few enough that the model can hold them all. */
const MAX_POLICY_LINES = 8;
const MAX_POLICY_BLOCKS = 12;

/**
 * One business policy, as a block the model can locate.
 *
 * The shape is the point. An organisation's rules arrive today as one run of prose, and a
 * model reading prose picks whichever clause is nearest rather than the one that applies.
 * Named blocks let it find the right one — and let it tell that there is no right one,
 * which is what 8g's prohibition on reasoning by analogy actually needs to be usable.
 *
 * `cannotDo` and `escalateWhen` are separate from `canDo` rather than negations inside it,
 * because they have different consequences: one is a refusal the agent explains, the other
 * hands the call to a person, and a model asked to infer which from a sentence will get it
 * wrong in the direction that keeps the call.
 */
const policyBlock = object({
  /** What a person would call it: "Refunds", "Late delivery". Short — it is a heading. */
  name: text({ minLength: 1, maxLength: MAX_POLICY_NAME_CHARS }),
  /** When this block is the relevant one. The sentence the model matches against. */
  applies: text({ minLength: 1, maxLength: MAX_POLICY_LINE_CHARS }),
  canDo: list(text({ minLength: 1, maxLength: MAX_POLICY_LINE_CHARS }), { maxItems: MAX_POLICY_LINES }),
  cannotDo: list(text({ minLength: 1, maxLength: MAX_POLICY_LINE_CHARS }), { maxItems: MAX_POLICY_LINES }),
  escalateWhen: list(text({ minLength: 1, maxLength: MAX_POLICY_LINE_CHARS }), { maxItems: MAX_POLICY_LINES }),
});

const CONFIG_FIELDS = {
  name: text({ minLength: 1, maxLength: LIMITS.name.chars }),
  voiceId: nullable(text({ maxLength: MAX_VOICE_ID_CHARS })),
  /** Null is the voice's own pace. 0.7 to 1.2, the range ElevenLabs renders cleanly. */
  speakingRate: nullable(number({ minimum: 0.7, maximum: 1.2 })),
  greeting: nullable(text({ maxLength: MAX_GREETING_CHARS })),
  persona: nullable(text({ maxLength: LIMITS.persona.chars })),
  instructions: nullable(text({ maxLength: LIMITS.instructions.chars })),
  /**
   * Bounded like every other free text here, and for the same reason: this is read on every
   * turn of every call, so a organization pasting a policy manual in is a latency cost paid
   * by their own callers. An empty list and null are the same thing to the prompt.
   */
  policyBlocks: optional(nullable(list(policyBlock, { maxItems: MAX_POLICY_BLOCKS }))),
  keyterms: list(text({ minLength: 1, maxLength: MAX_KEYTERM_CHARS }), { maxItems: MAX_KEYTERMS }),
  escalation: nullable(escalation),
};

const configFields = object(CONFIG_FIELDS);

const publication = object({
  ...CONFIG_FIELDS,
  /**
   * Required, as it is in `tools/organization/config.mjs`. A version with no reason explains
   * nothing three weeks later, which is the only moment anybody reads the history.
   */
  note: text({ minLength: 1, maxLength: MAX_NOTE_CHARS }),
});

const VERSION_SUMMARY = {
  version: integer({ minimum: 0 }),
  note: nullable(text({ maxLength: MAX_NOTE_CHARS })),
  /** The database role that published it. A person once the dashboard is the only writer. */
  publishedBy: text({ maxLength: 200 }),
  publishedAt: timestamp(),
};

const versionSummary = object(VERSION_SUMMARY);

const versionPage = pageResponse(versionSummary);

const configVersion = object({ ...VERSION_SUMMARY, config: configFields });

/**
 * What the transcriber is actually told to expect, which is never only what the organisation
 * asked for.
 *
 * `base` is here because it is inherited and cannot be removed, and because a organization looking
 * at their own two keyterms should be able to see the ones they did not choose. Boosting is
 * a bias rather than a hint — a listed token wins ties against everything unlisted — and the
 * base list alone, containing no personal name, has been measured turning a caller's name
 * into a different name. `publication.ts` and `tenancy/defaults.ts` carry the numbers.
 */
const vocabulary = object({
  base: list(text({ maxLength: MAX_KEYTERM_CHARS })),
  effective: list(text({ maxLength: MAX_KEYTERM_CHARS })),
  cap: integer({ minimum: 1 }),
});

/**
 * Set for the organisation rather than by it, and read-only for a reason per row.
 *
 * `dialledNumber` is the ingress routing table: an organisation that could write it could
 * claim a number nobody assigned it. The consent fields gate who may be dialled and when,
 * and an organisation asking to place calls must not be the one deciding whether the check
 * applies — the verdict lives in `outbound/consent.ts`, which also clamps the calling window
 * regardless of what these say. `audioRetentionDays` is how long a caller's voice is kept.
 *
 * They are served rather than hidden because "why can I not do this" is a support ticket
 * either way, and one the API can answer itself is cheaper than one it cannot.
 */
const operatorManaged = object({
  dialledNumber: nullable(text({ maxLength: 32 })),
  audioRetentionDays: integer({ minimum: 1 }),
  /**
   * How long the caller's words are kept — transcripts, call events and tool arguments.
   *
   * Shown beside the audio window and separate from it, because they are separate policies
   * and the words outlive the recording deliberately: the review loop corrects transcripts
   * and the eval corpus is built from those corrections. Read-only here for the same reason
   * `audioRetentionDays` is — the platform operator sets it, and a screen that could change
   * it would be a screen that could quietly extend how long identity numbers are held.
   */
  transcriptRetentionDays: integer({ minimum: 1 }),
  consent: object({
    policy: text({ maxLength: 64 }),
    basis: nullable(text({ maxLength: 500 })),
    callingEarliestHour: nullable(integer({ minimum: 0, maximum: 23 })),
    callingLatestHour: nullable(integer({ minimum: 0, maximum: 24 })),
  }),
});

const currentConfig = object({
  /** What a call answered right now records in `calls.config_version`. */
  version: integer({ minimum: 0 }),
  config: configFields,
  /**
   * The history row for the current version, or null when there is not one — a organization seeded
   * before migration 0011, or a row edited in place instead of published. Null is reported
   * rather than filled in: a version pointing at nothing is exactly the gap R7.5 closes.
   */
  published: nullable(versionSummary),
  vocabulary,
  operatorManaged,
});

const published = object({ version: configVersion, vocabulary });

/**
 * Every route on this surface now names its agent.
 *
 * It used to have none, and resolved the organisation's oldest live agent inside the
 * database — correct while an organisation could only have one, a silent coin toss the
 * moment it can have two. `agentPath` is the whole of the fix at this layer; the refusal to
 * act on somebody else's agent lives below, in RLS and in the functions migrations 0050 and
 * 0052 taught to check the scope.
 */
const agentPath = object({ agentId: uuid() });

const versionPath = object({ agentId: uuid(), version: integer({ minimum: 1 }) });

/**
 * Which two versions to compare.
 *
 * Both required, and neither defaults to "the current one". A diff whose left-hand side is
 * implicit is a diff that means something different tomorrow, and this is a URL somebody
 * pastes into a conversation about a call that has already happened.
 */
const diffQuery = object({
  from: integer({ minimum: 1 }),
  to: integer({ minimum: 1 }),
});

/**
 * One field that moved.
 *
 * No `maxLength` on the values, for the reason the transcript field on the calls endpoint
 * gives: these come out of the database, the interceptor projects the response through this
 * schema, and a bound here would turn one long persona into a 500 for the whole comparison.
 * The bounds that matter are on the publish body, where the value arrived.
 */
const fieldChange = object({
  /** Dotted path into the configuration, e.g. `greeting` or `escalation.ringSeconds`. */
  field: text({ maxLength: 64 }),
  /** Null where that version did not set the field, which is not the same as an empty one. */
  before: nullable(text()),
  after: nullable(text()),
});

const versionDiff = object({
  from: versionSummary,
  to: versionSummary,
  /** True when the two versions would produce the same agent. Both lists are then empty. */
  identical: flag(),
  fields: list(fieldChange),
  keyterms: object({
    added: list(text({ maxLength: MAX_KEYTERM_CHARS })),
    removed: list(text({ maxLength: MAX_KEYTERM_CHARS })),
  }),
});

/* No body. Restoring fills the draft, and a draft carries no note — the provenance travels
   as `restoredFrom` and becomes the note when the draft is published. */

const callPath = object({ agentId: uuid(), callId: uuid() });

const callConfig = object({
  callId: uuid(),
  /** Null on a call answered before a version was recorded against it. */
  configVersion: nullable(integer({ minimum: 0 })),
  /** Null when that version has no snapshot behind it. */
  version: nullable(configVersion),
});

const guarantee = object({
  /** The PRD requirement, or the property of the layering, this restates. */
  id: text({ maxLength: 64 }),
  /** Where it is actually held up. Not a policy — a dispatch path, a scheduler or Postgres. */
  enforcedIn: text({ maxLength: 200 }),
  restatedToTheModel: flag(),
});

const guarantees = object({ guarantees: list(guarantee) });

/**
 * Work saved but not published.
 *
 * The same fields a publication carries and no note, because a note explains a version and a
 * draft is not one. Saving is not an event in the agent's history — it is somebody still
 * deciding — so nothing here is appended to `agent_prompt_versions` and nothing here is
 * visible to a call.
 */
const draftBody = object({ ...CONFIG_FIELDS });

const draft = object({
  /**
   * Each section is null when nothing on it has been staged, and the console renders the live
   * value in its place. Null is not "empty": an empty tool list is a deliberate choice that an
   * agent reaches none of them, and publishing it would apply that.
   */
  config: nullable(configFields),
  capturedFields: nullable(list(capturedField, { maxItems: MAX_CAPTURED_FIELDS })),
  tools: nullable(list(text({ maxLength: 120 }), { maxItems: 200 })),
  knowledge: nullable(list(uuid(), { maxItems: 500 })),
  /**
   * The two behaviour flags, each null until it is staged.
   *
   * Separately nullable rather than one object, because the console flips one switch at a
   * time: a shared section would have to carry the other flag's value as the page last read
   * it, and that stale copy is what reverts it. `false` is a staged "off", not an absence.
   */
  bargeIn: nullable(flag()),
  answeringMachineDetection: nullable(flag()),
  /** Null when the account that saved it is gone but the work is not. */
  updatedBy: nullable(uuid()),
  /** The version this was loaded from, for the publish note to offer. Null when typed. */
  restoredFrom: nullable(integer({ minimum: 0 })),
  updatedAt: timestamp(),
});

/** Null rather than a 404: "nothing unpublished" is the ordinary state, not a missing thing. */
const draftState = object({ draft: nullable(draft) });

const discarded = object({ discarded: flag() });

/** The response shape shared by everything that returns a stored configuration. */
const toConfigBody = (config: AgentConfigFields): Infer<typeof configFields> => ({
  name: config.name,
  voiceId: config.voiceId,
  speakingRate: config.speakingRate,
  greeting: config.greeting,
  persona: config.persona,
  instructions: config.instructions,
  /* Stored as jsonb and therefore `unknown` on the way out. Cast rather than re-validated:
     it was validated by this same schema on the way in, and a second parse here would be a
     second definition of what a policy is. */
  policyBlocks: (config.policyBlocks ?? null) as Infer<typeof configFields>["policyBlocks"],
  keyterms: [...config.keyterms],
  escalation: config.escalation,
});

/**
 * A stored draft as the wire sees it.
 *
 * One mapping rather than the same eight lines in `readDraft`, `saveDraft` and `rollback`.
 * Three copies is how a section gets staged and then never reported by one of the three, and
 * the symptom of that is a console showing live values for work somebody saved.
 */
const toDraftBody = (found: AgentDraft): Infer<typeof draft> => ({
  config: found.config === null ? null : toConfigBody(found.config),
  capturedFields: found.capturedFields as Infer<typeof draft>["capturedFields"],
  tools: found.tools === null ? null : [...found.tools],
  knowledge: found.knowledge === null ? null : [...found.knowledge],
  bargeIn: found.bargeIn,
  answeringMachineDetection: found.answeringMachineDetection,
  updatedBy: found.updatedBy,
  restoredFrom: found.restoredFrom,
  updatedAt: found.updatedAt,
});

/** The history row without the snapshot hanging off it, for the two ends of a diff. */
const toSummary = (version: ConfigVersion): Infer<typeof versionSummary> => ({
  version: version.version,
  note: version.note,
  publishedBy: version.publishedBy,
  publishedAt: version.publishedAt,
});

const toVocabulary = (configured: readonly string[]): Infer<typeof vocabulary> => ({
  base: [...BASE_KEYTERMS],
  effective: [...effectiveKeyterms(configured)],
  cap: MAX_KEYTERMS,
});

@Controller(apiRoute("agents/:agentId/config"))
export class ConfigController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  /**
   * Literal segments before parameterised ones, because Nest matches in declaration order
   * and would otherwise read `guarantees` as a value for `:version`.
   */
  @Get("guarantees")
  @Endpoint({
    summary: "What this organisation cannot configure, and where each rule is enforced",
    description:
      "Generated from the list the platform actually enforces, so it cannot describe a rule " +
      "that stopped being enforced. A publication tripping one of these is refused with 422 " +
      "naming the id — and the rule would have held anyway, because none of them is held up " +
      "by the prompt.",
    capability: "config:read",
    params: agentPath,
    response: guarantees,
  })
  listGuarantees(): Infer<typeof guarantees> {
    return { guarantees: publishedGuarantees() };
  }

  /**
   * Also a literal segment, and also declared before `versions/:version` — although this
   * one would not collide, keeping every fixed path above every parameterised one is the
   * rule that stops the next addition from having to think about it.
   */
  @Get("diff")
  @Endpoint({
    summary: "What changed between two configuration versions",
    description:
      "Only the fields that moved, with the nested shapes flattened to dotted paths — " +
      "`businessHours.closesAtHour` rather than two objects to compare by eye. Keyterms are " +
      "compared as a set, without regard to case, because they are a bias on the transcriber " +
      "rather than a sequence and reordering them changes nothing on a call. 404 if either " +
      "version has no snapshot behind it.",
    capability: "config:read",
    params: agentPath,
    query: diffQuery,
    response: versionDiff,
  })
  async diff(
    @FromPath() path: Infer<typeof agentPath>,
    @FromQuery() query: Infer<typeof diffQuery>,
  ): Promise<Infer<typeof versionDiff>> {
    // One transaction, one query after the other. Both ends of the comparison are read
    // from the same snapshot, and two queries raced onto one connection is a driver
    // problem rather than a speed-up.
    const pair = await this.db.tx(async (scope) => ({
      from: await loadAgentConfigVersion(scope, path.agentId, query.from),
      to: await loadAgentConfigVersion(scope, path.agentId, query.to),
    }));

    // 404 for either, and deliberately without saying which: under RLS another
    // organisation's version and one that never existed are the same query result.
    const { from, to } = pair;
    if (from === null || to === null) throw new NotFoundException();
    return {
      from: toSummary(from),
      to: toSummary(to),
      ...diffConfigurations(from.config, to.config),
    };
  }

  @Get("versions")
  @Endpoint({
    summary: "Every configuration version this organisation has published, newest first",
    capability: "config:read",
    params: agentPath,
    query: pageQuery,
    response: versionPage,
  })
  async listVersions(
    @FromPath() path: Infer<typeof agentPath>,
    @FromQuery() query: Infer<typeof pageQuery>,
  ): Promise<Infer<typeof versionPage>> {
    const page = toPageRequest(query);
    return toPageBody(
      await this.db.tx((scope) => listAgentConfigVersions(scope, path.agentId, page)),
      query,
    );
  }

  @Post("versions")
  @Endpoint({
    summary: "Publish a new configuration version",
    description:
      "The whole configuration, not a patch: a field left out is a field cleared, so every " +
      "one of them is required. Tool and event configuration is not settable here and is " +
      "carried forward unchanged inside the same transaction. Bumps the version and " +
      "snapshots it atomically, so the number recorded on every subsequent call has a row " +
      "behind it.",
    capability: "config:write",
    params: agentPath,
    body: publication,
    response: published,
    status: 201,
  })
  async publish(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof publication>,
  ): Promise<Infer<typeof published>> {
    const problems = publicationProblems(body);
    if (problems.length > 0) throw new ValidationFailed(problems);

    const { note, ...fields } = body;
    const version = await this.db.tx(async (scope) => {
      /*
       * Publishing is the one act, so everything staged goes live together and in one
       * transaction. The order is not arbitrary:
       *
       *   1. the form, onto the agent row, *before* the snapshot — `publish_agent_config`
       *      reads `captured_fields` off that row, so applying it afterwards would publish
       *      the form but record the old one in the history, and the version a call points
       *      at would describe an agent that never existed.
       *   2. the configuration, which bumps the version, writes the snapshot, and deletes
       *      the draft.
       *   3. the two selections, which live in join tables the snapshot does not cover, and
       *      the behaviour flags, which `agent_prompt_versions` has no column for — checked
       *      against the table rather than assumed, so nothing here needs to precede it.
       *
       * Absent sections are left alone rather than cleared. Null means nobody staged one,
       * and a publish that blanked an agent's tools because the operator only edited the
       * greeting is the whole class of defect this slice exists to end.
       */
      const agentId = path.agentId;
      const staged = agentId === null ? null : await loadAgentDraft(scope, agentId);

      if (agentId !== null && staged?.capturedFields != null) {
        await applyCapturedFields(scope, agentId, staged.capturedFields);
      }

      /* The graph, onto the agent row and before the snapshot, for the same reason the form
         is: `publish_agent_config` selects `flow` and `authoring_mode` off that row, so
         applying them afterwards would publish the graph but record the old one — and the
         version a call points at would describe an agent that never existed.

         Read through `loadDraftFlow` rather than off `staged`: `AgentDraft` deliberately does
         not carry a graph, because the canvas is saved and read on its own screen. Undefined
         leaves a column alone, which is what makes publishing a greeting safe for a canvas
         somebody else staged. */
      const stagedFlow = agentId === null ? null : await loadDraftFlow(scope, agentId);

      /* Whether the graph about to go live could answer a phone.
       *
       * Checked against what the agent will be *after* this publish, not against what was
       * staged: switching the mode to "flow" without touching the canvas and redrawing the
       * canvas without touching the mode are two separate saves, and either one alone can
       * produce a live agent that stalls. Falling back to the published values is what makes
       * the pair of them add up.
       *
       * Inside the transaction and before `applyAgentFlow`, so a refusal rolls back rather
       * than leaving the graph applied and the version unwritten — which would be an agent
       * whose live shape no version describes.
       *
       * `loadPublishedFlow` and not `loadDraftFlow` for the fallback: this is a publish
       * deciding what will be true, and reading the other draft to answer that would be
       * exactly the confusion rule 4 exists to prevent. */
      const live = agentId === null ? null : await loadPublishedFlow(scope, agentId);
      /* Null is an agent this organisation cannot see. Say nothing about its graph and let
         the publish below produce the 404 — a 422 about a flow would confirm the agent
         exists to somebody who is not entitled to know it does. */
      if (live !== null) {
        const flowProblems = flowPublicationProblems({
          authoringMode: stagedFlow?.authoringMode ?? live.authoringMode,
          flow: stagedFlow?.flow ?? live.flow,
        });
        if (flowProblems.length > 0) throw new ValidationFailed(flowProblems);
      }

      if (agentId !== null && (stagedFlow?.flow != null || stagedFlow?.authoringMode != null)) {
        await applyAgentFlow(scope, agentId, {
          ...(stagedFlow.flow === null ? {} : { flow: stagedFlow.flow }),
          ...(stagedFlow.authoringMode === null ? {} : { authoringMode: stagedFlow.authoringMode }),
        });
      }

      const version = await publishAgentConfig(scope, path.agentId, fields, note);

      if (agentId !== null && staged?.tools != null) {
        await setAgentTools(scope, agentId, staged.tools);
      }
      if (agentId !== null && staged?.knowledge != null) {
        await setAgentKnowledgeSources(scope, agentId, staged.knowledge);
      }
      if (agentId !== null && (staged?.bargeIn != null || staged?.answeringMachineDetection != null)) {
        await applyAgentBehaviour(scope, agentId, {
          ...(staged.bargeIn === null ? {} : { bargeIn: staged.bargeIn }),
          ...(staged.answeringMachineDetection === null
            ? {}
            : { answeringMachineDetection: staged.answeringMachineDetection }),
        });
      }

      // Read back inside the same transaction rather than echoing the request. What comes
      // out is what was stored, with the author and the timestamp the database assigned, so
      // the response is evidence rather than a restatement of the body.
      return loadAgentConfigVersion(scope, path.agentId, version);
    });

    if (version === null) {
      throw new Error("published a version that cannot be read back");
    }
    return {
      version: { ...version, config: toConfigBody(version.config) },
      // Returned on publish and not only on read, because this is the moment a keyterm list
      // becomes real and the moment its cost is worth seeing.
      vocabulary: toVocabulary(version.config.keyterms),
    };
  }

  /**
   * R7.5's other half: getting back to a configuration that worked.
   *
   * **It loads the old version into the draft. It does not publish.** This used to publish
   * directly, and that made it a second way to change what a caller hears without pressing
   * Publish — the exact hole the draft exists to close. Restoring now means "put version 4
   * back on my screen"; making it answer the phone is still one deliberate act, and the
   * operator gets to see what they are about to reinstate first.
   *
   * Nothing is rewritten either way. `calls.config_version` points into the version table, so
   * a row edited or removed here would make a call from three weeks ago unexplainable, and
   * that explanation is the only thing that makes a recording of a bad call actionable.
   *
   * **Through the same validation as a publish**, which is easy to skip and would quietly
   * matter. A guarantee added to `prompts/guarantees.ts` since version 4 was published means
   * version 4's persona now contains a sentence the platform refuses. Loading it into the
   * draft unchecked would hand somebody a draft that cannot be published, and they would find
   * out at the moment they wanted it live.
   *
   * Restoring the version that is already live is allowed and simply fills the draft with
   * what is already there, which publishes as a no-op with a note. That is the honest way to
   * record "we considered it and put it back where it was".
   */
  @Post("versions/:version/rollback")
  @Endpoint({
    summary: "Load an earlier version's configuration into the draft",
    description:
      "Does not publish. The stored version is copied into the unpublished draft so it can be " +
      "reviewed and then published deliberately — publishing straight from here would be a " +
      "second way to change a live call without pressing Publish. Never rewrites history: the " +
      "version being restored stays exactly as it was, so a call that recorded it can still be " +
      "explained. Runs the same guarantee and keyterm checks a publish does and answers 422 " +
      "with the field named if the stored version would not be accepted today.",
    capability: "config:write",
    params: versionPath,
    response: draft,
  })
  async rollback(
    @FromPath() path: Infer<typeof versionPath>,
  ): Promise<Infer<typeof draft>> {
    const restored = await this.db.tx(async (scope) => {
      const agentId = path.agentId;
      const source = await loadAgentConfigVersion(scope, path.agentId, path.version);
      if (source === null) throw new NotFoundException();

      const problems = publicationProblems(source.config);
      if (problems.length > 0) {
        // Re-pointed at the version rather than at a request body, because there is no
        // field in this request to correct. What has to change is the stored configuration,
        // and naming `body.persona` would send somebody looking for a persona they did not
        // send.
        throw new ValidationFailed(
          problems.map((problem) => ({
            ...problem,
            path: problem.path.replace(/^body\./, `versions.${path.version}.`),
          })),
        );
      }

      await saveAgentDraft(scope, agentId, source.config, null, path.version);
      // Read back inside the same transaction, as the publish endpoint does: the response is
      // the row the database wrote rather than an echo of the row it was copied from.
      return loadAgentDraft(scope, agentId);
    });

    if (restored === null) throw new Error("saved a draft that cannot be read back");
    return toDraftBody(restored);
  }

  /**
   * The three endpoints that make Save and Publish different acts.
   *
   * Before these, the console had one way to write and it went live immediately, so a button
   * saying "Save voice and rate" published every tab onto the next call. The fix is not a
   * better label — it is that saving has somewhere to go that a call cannot read.
   *
   * They sit on `config` rather than on `agents` because a draft is a configuration document:
   * the same fields, the same validation, compared with `diffConfigurations` against the live
   * one. Which agent it belongs to is resolved exactly as publishing resolves it, through
   * `app.live_agent_for_organization`, so a publish cannot consume a different agent's draft
   * than the one it published to.
   */
  @Get("draft")
  @Endpoint({
    summary: "Configuration saved but not published",
    description:
      "Null when there is nothing unpublished, which is the ordinary state rather than a " +
      "missing resource. Nothing on a call reads this: the live read path takes the agent's " +
      "own columns and cannot see a draft at all.",
    capability: "config:read",
    params: agentPath,
    response: draftState,
  })
  async readDraft(@FromPath() path: Infer<typeof agentPath>): Promise<Infer<typeof draftState>> {
    const found = await this.db.tx(async (scope) => {
      const agentId = path.agentId;
      return loadAgentDraft(scope, agentId);
    });

    if (found === null) return { draft: null };
    return { draft: toDraftBody(found) };
  }

  @Put("draft")
  @Endpoint({
    summary: "Save configuration without making it live",
    description:
      "Replaces the whole draft, for the same reason a publication is whole: a partial draft " +
      "would have to be merged against a live document that may have moved since, and the " +
      "merge is where the wrong greeting goes out. Validated exactly as a publish is, so a " +
      "draft cannot be saved that could never be published. Changes nothing about a call in " +
      "progress or a call that arrives a second later.",
    capability: "config:write",
    params: agentPath,
    body: draftBody,
    response: draft,
  })
  async saveDraft(
    @FromPath() path: Infer<typeof agentPath>,
    @FromBody() body: Infer<typeof draftBody>,
  ): Promise<Infer<typeof draft>> {
    // The same check a publish makes, deliberately. A draft that passes here and fails at
    // publish is a trap: the operator is told it saved, and finds out it was never publishable
    // at the moment they wanted it live.
    const problems = publicationProblems(body);
    if (problems.length > 0) throw new ValidationFailed(problems);

    const saved = await this.db.tx(async (scope) => {
      const agentId = path.agentId;
      await saveAgentDraft(scope, agentId, body, null, null);
      // Read back inside the transaction rather than echoing the request, as publish does:
      // the response carries the timestamp the database assigned.
      return loadAgentDraft(scope, agentId);
    });

    if (saved === null) throw new NotFoundException();
    return toDraftBody(saved);
  }

  @Delete("draft")
  @Endpoint({
    summary: "Throw away unpublished work",
    description:
      "The first of the two ways back. This one forgets what has been saved since the last " +
      "publish and leaves no trace, because a draft nobody published never answered a call " +
      "and is not part of the history. The other way back is rolling a published version " +
      "into the draft, which does go through the version list. False means there was nothing " +
      "to discard.",
    capability: "config:write",
    params: agentPath,
    response: discarded,
  })
  async discardDraft(@FromPath() path: Infer<typeof agentPath>): Promise<Infer<typeof discarded>> {
    const gone = await this.db.tx(async (scope) => {
      const agentId = path.agentId;
      return discardAgentDraft(scope, agentId);
    });

    if (gone === null) throw new NotFoundException();
    return { discarded: gone };
  }

  @Get("versions/:version")
  @Endpoint({
    summary: "One configuration version, as it was published",
    description:
      "Addressable, so the version a call recorded can be linked to rather than described.",
    capability: "config:read",
    params: versionPath,
    response: configVersion,
  })
  async version(@FromPath() path: Infer<typeof versionPath>): Promise<Infer<typeof configVersion>> {
    const found = await this.db.tx((scope) =>
      loadAgentConfigVersion(scope, path.agentId, path.version),
    );
    // Under RLS, another organisation's version and a version that never existed are the
    // same query result, and answering differently would confirm which.
    if (found === null) throw new NotFoundException();
    return { ...found, config: toConfigBody(found.config) };
  }

  @Get("calls/:callId")
  @Endpoint({
    summary: "The configuration that served one call",
    description:
      "R7.5 asked from the useful end: not 'what is version 4' but 'what was the agent " +
      "working from when it said that'. Answers with the snapshot rather than the number.",
    capability: "config:read",
    params: callPath,
    response: callConfig,
  })
  async forCall(@FromPath() path: Infer<typeof callPath>): Promise<Infer<typeof callConfig>> {
    const trace = await this.db.tx((scope) => loadConfigVersionForCall(scope, path.callId));
    if (trace === null) throw new NotFoundException();
    return {
      callId: trace.callId,
      configVersion: trace.configVersion,
      version:
        trace.version === null
          ? null
          : { ...trace.version, config: toConfigBody(trace.version.config) },
    };
  }

  @Get()
  @Endpoint({
    summary: "The configuration the agent is answering on right now",
    description:
      "The live values, which are what calls run on, with the history row for them alongside " +
      "and the vocabulary they resolve to. `operatorManaged` is read-only and has no " +
      "counterpart in the publish body.",
    capability: "config:read",
    params: agentPath,
    response: currentConfig,
  })
  async current(@FromPath() path: Infer<typeof agentPath>): Promise<Infer<typeof currentConfig>> {
    const found = await this.db.tx((scope) => loadCurrentAgentConfig(scope, path.agentId));
    /* Null is now "no such agent for you" as well as "the organisation is gone": RLS decides
       whether the id in the path is readable at all, so another organisation's agent and one
       that never existed are the same 404. */
    if (found === null) throw new NotFoundException();

    const { consentPolicy, consentBasis, callingEarliestHour, callingLatestHour, ...operator } =
      found.operatorManaged;
    return {
      version: found.version,
      config: toConfigBody(found.config),
      published: found.published,
      vocabulary: toVocabulary(found.config.keyterms),
      operatorManaged: {
        ...operator,
        consent: {
          policy: consentPolicy,
          basis: consentBasis,
          callingEarliestHour,
          callingLatestHour,
        },
      },
    };
  }
}
