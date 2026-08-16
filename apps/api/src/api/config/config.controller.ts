import {
  listAgentConfigVersions,
  loadConfigVersionForCall,
  loadCurrentAgentConfig,
  loadAgentConfigVersion,
  publishAgentConfig,
  type ConfigVersion,
  type AgentConfigFields,
} from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Post } from "@nestjs/common";

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
  number,
  object,
  optional,
  text,
  type Infer,
} from "../http/schema";
import { phoneNumber, timestamp, uuid } from "../schemas";
import { OrganizationContext } from "../tenancy/organization-context";

import { diffConfigurations } from "./diff";
import { effectiveKeyterms, publicationProblems, publishedGuarantees } from "./publication";

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
const businessHours = object({
  /** WAT, inclusive. */
  opensAtHour: integer({ minimum: 0, maximum: 23 }),
  /** WAT, exclusive, so a line that shuts at five holds 17. */
  closesAtHour: integer({ minimum: 1, maximum: 24 }),
  /** ISO weekdays: 1 is Monday, 7 is Sunday. */
  openDays: list(integer({ minimum: 1, maximum: 7 }), { maxItems: 7 }),
});

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
const CONFIG_FIELDS = {
  name: text({ minLength: 1, maxLength: LIMITS.name.chars }),
  voiceId: nullable(text({ maxLength: MAX_VOICE_ID_CHARS })),
  /** Null is the voice's own pace. 0.7 to 1.2, the range ElevenLabs renders cleanly. */
  speakingRate: nullable(number({ minimum: 0.7, maximum: 1.2 })),
  greeting: nullable(text({ maxLength: MAX_GREETING_CHARS })),
  persona: nullable(text({ maxLength: LIMITS.persona.chars })),
  instructions: nullable(text({ maxLength: LIMITS.instructions.chars })),
  keyterms: list(text({ minLength: 1, maxLength: MAX_KEYTERM_CHARS }), { maxItems: MAX_KEYTERMS }),
  businessHours: nullable(businessHours),
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

const versionPath = object({ version: integer({ minimum: 1 }) });

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

/**
 * Shorter than a publish note, because the version this one is restored from is appended to
 * whatever is written here and the whole thing has to stay inside `MAX_NOTE_CHARS` — a note
 * that overflowed would fail the response projection and answer 500 on a successful publish.
 */
const MAX_ROLLBACK_NOTE = 400;

const rollback = object({
  /**
   * Why. Optional here and required on a publish, which is the one difference between them:
   * "restored from version 4" is already a reason, and the version it names is the rest of
   * the explanation. Anything written here is kept and the provenance is appended to it.
   */
  note: optional(text({ minLength: 1, maxLength: MAX_ROLLBACK_NOTE })),
});

const callPath = object({ callId: uuid() });

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

/** The response shape shared by everything that returns a stored configuration. */
const toConfigBody = (config: AgentConfigFields): Infer<typeof configFields> => ({
  name: config.name,
  voiceId: config.voiceId,
  speakingRate: config.speakingRate,
  greeting: config.greeting,
  persona: config.persona,
  instructions: config.instructions,
  keyterms: [...config.keyterms],
  businessHours:
    config.businessHours === null
      ? null
      : { ...config.businessHours, openDays: [...config.businessHours.openDays] },
  escalation: config.escalation,
});

/** The history row without the snapshot hanging off it, for the two ends of a diff. */
const toSummary = (version: ConfigVersion): Infer<typeof versionSummary> => ({
  version: version.version,
  note: version.note,
  publishedBy: version.publishedBy,
  publishedAt: version.publishedAt,
});

/**
 * The note a rollback records.
 *
 * The version it was restored from is always in it, whether or not the caller wrote
 * anything. Without that the history reads as somebody having retyped an old configuration
 * by hand, and the one question the history exists to answer — why does version 9 look like
 * version 4 — has no answer in it.
 */
const rollbackNote = (from: number, note: string | undefined): string =>
  note === undefined
    ? `restored from version ${from}`
    : `${note} (restored from version ${from})`;

const toVocabulary = (configured: readonly string[]): Infer<typeof vocabulary> => ({
  base: [...BASE_KEYTERMS],
  effective: [...effectiveKeyterms(configured)],
  cap: MAX_KEYTERMS,
});

@Controller(apiRoute("config"))
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
    query: diffQuery,
    response: versionDiff,
  })
  async diff(@FromQuery() query: Infer<typeof diffQuery>): Promise<Infer<typeof versionDiff>> {
    // One transaction, one query after the other. Both ends of the comparison are read
    // from the same snapshot, and two queries raced onto one connection is a driver
    // problem rather than a speed-up.
    const pair = await this.db.tx(async (scope) => ({
      from: await loadAgentConfigVersion(scope, query.from),
      to: await loadAgentConfigVersion(scope, query.to),
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
    query: pageQuery,
    response: versionPage,
  })
  async listVersions(
    @FromQuery() query: Infer<typeof pageQuery>,
  ): Promise<Infer<typeof versionPage>> {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listAgentConfigVersions(scope, page)), query);
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
    body: publication,
    response: published,
    status: 201,
  })
  async publish(@FromBody() body: Infer<typeof publication>): Promise<Infer<typeof published>> {
    const problems = publicationProblems(body);
    if (problems.length > 0) throw new ValidationFailed(problems);

    const { note, ...fields } = body;
    const version = await this.db.tx(async (scope) => {
      const version = await publishAgentConfig(scope, fields, note);
      // Read back inside the same transaction rather than echoing the request. What comes
      // out is what was stored, with the author and the timestamp the database assigned, so
      // the response is evidence rather than a restatement of the body.
      return loadAgentConfigVersion(scope, version);
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
   * **It publishes; it does not restore.** The old snapshot's content becomes a new version
   * with a new number, and every row that was there before is still there and still says
   * what it said. That is not tidiness — `calls.config_version` points into this table, so
   * a row edited or removed here would make a call from three weeks ago unexplainable, and
   * the explanation is the only thing that makes a recording of a bad call actionable.
   *
   * **Through the same validation as a publish**, which is the part that is easy to skip
   * and would quietly matter. A guarantee added to `prompts/guarantees.ts` since version 4
   * was published means version 4's persona now contains a sentence the platform refuses;
   * restoring it without checking would put the organisation back on a configuration the
   * publish endpoint would not accept from them today, and the field would be dropped from
   * the prompt on every call instead — silently, exactly as it would have been before
   * `publication.ts` existed.
   *
   * Rolling back to the current version is allowed and publishes an identical version. It
   * is a no-op with a note, which is the honest way to record "we considered it and put it
   * back where it was".
   */
  @Post("versions/:version/rollback")
  @Endpoint({
    summary: "Publish an earlier version's configuration as a new version",
    description:
      "Never rewrites history: the version being rolled back to stays exactly as it was and " +
      "a new version number is issued, so a call that recorded an older one can still be " +
      "explained. Runs the same guarantee and keyterm checks a publish does and answers 422 " +
      "with the field named if the stored version would not be accepted today. Tool and " +
      "event configuration is carried forward from the live document, not from the snapshot — " +
      "the version table does not hold it.",
    capability: "config:write",
    params: versionPath,
    body: rollback,
    response: published,
    status: 201,
  })
  async rollback(
    @FromPath() path: Infer<typeof versionPath>,
    @FromBody() body: Infer<typeof rollback>,
  ): Promise<Infer<typeof published>> {
    const restored = await this.db.tx(async (scope) => {
      const source = await loadAgentConfigVersion(scope, path.version);
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

      const number = await publishAgentConfig(
        scope,
        source.config,
        rollbackNote(path.version, body.note),
      );
      // Read back inside the same transaction, as the publish endpoint does: the response
      // is the row the database wrote rather than an echo of the row it was copied from.
      return loadAgentConfigVersion(scope, number);
    });

    if (restored === null) throw new Error("published a version that cannot be read back");
    return {
      version: { ...restored, config: toConfigBody(restored.config) },
      vocabulary: toVocabulary(restored.config.keyterms),
    };
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
    const found = await this.db.tx((scope) => loadAgentConfigVersion(scope, path.version));
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
    response: currentConfig,
  })
  async current(): Promise<Infer<typeof currentConfig>> {
    const found = await this.db.tx((scope) => loadCurrentAgentConfig(scope));
    // The organisation behind a live session always has a row; this is the session outliving
    // a deleted organization, which is a 404 rather than a 500.
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
