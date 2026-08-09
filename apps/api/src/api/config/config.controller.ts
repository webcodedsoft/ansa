import {
  listTenantConfigVersions,
  loadConfigVersionForCall,
  loadCurrentTenantConfig,
  loadTenantConfigVersion,
  publishTenantConfig,
  type TenantConfigFields,
} from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Post } from "@nestjs/common";

import { LIMITS } from "../../prompts/tenant-layer";
import { BASE_KEYTERMS, MAX_KEYTERMS } from "../../tenancy/defaults";
import { Endpoint } from "../http/endpoint";
import { pageQuery, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { ValidationFailed } from "../http/problem";
import { apiRoute, FromBody, FromPath, FromQuery } from "../http/request";
import { flag, integer, list, nullable, object, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

import { effectiveKeyterms, publicationProblems, publishedGuarantees } from "./publication";

/**
 * The agent's configuration: what it says, how it sounds, what it listens for, and every
 * version of that there has ever been.
 *
 * Three things shape this surface, and none of them is "expose the columns".
 *
 * **Versioning is the interface, not an implementation detail.** `tenant_prompt_versions` is
 * append-only, `app.publish_tenant_config` bumps and snapshots in one statement, and every
 * call records the version that served it. Hiding that behind a `PATCH /config` would throw
 * away the only thing that makes R7.5 answerable, so a change is a POST that creates a
 * version, a version has a URL, and a call can be handed back the configuration it ran on.
 *
 * **A publication is whole, and every field is required.** That is not pedantry: the publish
 * function writes what it is given and nulls what it is not, so a body with `greeting`
 * missing is a body that deletes the greeting. Making the field required turns "I forgot"
 * into a 422 rather than into a caller hearing a different first sentence tomorrow.
 *
 * **What a tenant cannot set has no slot to set it in.** The operator's columns come back on
 * `GET /config` and appear nowhere in the request body, so an attempt to send one is a 422
 * from the schema layer rather than a rule somebody has to enforce. `GET /config/guarantees`
 * serves the rest of the §1 table from the code that enforces it.
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
 * E.164, as migration 0015's CHECK constraint spells it and as `handoff/destination.ts`
 * spells it for the environment fallback. A third copy, because the other two are a SQL
 * constraint and a module-private constant; the database remains the boundary and this only
 * moves the failure from a 500 to a 422 with the field named.
 */
const E164 = /^\+[1-9][0-9]{6,14}$/;

const phoneNumber = () => text({ maxLength: 16, pattern: E164 });

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
 * The character limits on `name`, `persona` and `instructions` are `prompts/tenant-layer.ts`'s
 * own, imported rather than repeated. Text past them is silently clamped on the way into the
 * prompt, so accepting a longer value here would store something the agent never reads.
 */
const CONFIG_FIELDS = {
  name: text({ minLength: 1, maxLength: LIMITS.name.chars }),
  voiceId: nullable(text({ maxLength: MAX_VOICE_ID_CHARS })),
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
   * Required, as it is in `tools/tenant/config.mjs`. A version with no reason explains
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
 * `base` is here because it is inherited and cannot be removed, and because a tenant looking
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
   * The history row for the current version, or null when there is not one — a tenant seeded
   * before migration 0011, or a row edited in place instead of published. Null is reported
   * rather than filled in: a version pointing at nothing is exactly the gap R7.5 closes.
   */
  published: nullable(versionSummary),
  vocabulary,
  operatorManaged,
});

const published = object({ version: configVersion, vocabulary });

const versionPath = object({ version: integer({ minimum: 1 }) });

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
const toConfigBody = (config: TenantConfigFields): Infer<typeof configFields> => ({
  name: config.name,
  voiceId: config.voiceId,
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

const toVocabulary = (configured: readonly string[]): Infer<typeof vocabulary> => ({
  base: [...BASE_KEYTERMS],
  effective: [...effectiveKeyterms(configured)],
  cap: MAX_KEYTERMS,
});

@Controller(apiRoute("config"))
export class ConfigController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

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
    return toPageBody(await this.db.tx((scope) => listTenantConfigVersions(scope, page)));
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
      const number = await publishTenantConfig(scope, fields, note);
      // Read back inside the same transaction rather than echoing the request. What comes
      // out is what was stored, with the author and the timestamp the database assigned, so
      // the response is evidence rather than a restatement of the body.
      return loadTenantConfigVersion(scope, number);
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
    const found = await this.db.tx((scope) => loadTenantConfigVersion(scope, path.version));
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
    const found = await this.db.tx((scope) => loadCurrentTenantConfig(scope));
    // The organisation behind a live session always has a row; this is the session outliving
    // a deleted tenant, which is a 404 rather than a 500.
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
