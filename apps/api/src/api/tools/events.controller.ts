import {
  EVENT_TYPES,
  parseEventConfig,
  parseRedactionPolicy,
  REDACTION_CATEGORIES,
  type EventConfig,
  type RedactionPolicy,
} from "@ansa/tools";
import {
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Put,
} from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody } from "../http/request";
import { choice, flag, integer, list, object, optional, text, type Infer } from "../http/schema";
import { TenantContext } from "../tenancy/tenant-context";

import { checkEventConfig, orConflict, orRefuse, toolsOrNothing } from "./refusals";
import { publishConfiguration, readConfiguration, sealedCredentials } from "./store";
import { classifyCredentials, credentialUses, refuseUnusableReferences, vaultKey } from "./vault";

/**
 * Where an organisation's own calls get pushed to, and what is masked on the way.
 *
 * Not a tool, and the difference is not cosmetic — see `packages/tools/src/events/config.ts`.
 * A tool call is decided by the model mid-conversation on a three-second budget; a delivery
 * is decided by the platform after the fact and cannot touch a call. They are two documents
 * and two validators, and they share only the things below the seam: the egress allowlist,
 * the credential vault and the guarded transport.
 *
 * **Redaction defaults to nothing, and that is the position rather than an oversight.** The
 * organisation is the data controller, the caller is their customer, and the payload is a
 * record of a conversation their own agent had. Withholding it on a judgement we made about
 * their compliance posture is not our call, and it would break the obvious uses — the CRM
 * that needs the policy number, the ticketing system that needs the callback number. What
 * `docs/EVENT_WEBHOOKS.md` says about the limits of each category is the part worth reading
 * before switching one on: a name in prose, an address and a date of birth have no shape
 * that distinguishes them from ordinary speech and no category will ever find them.
 *
 * Credential-shaped keys are stripped from every payload unconditionally, and that is not
 * a field on this document in either direction. It is not the organisation's data; it is
 * material held in trust.
 */

const CREDENTIAL_REF = /^[a-z][a-z0-9_]{1,63}$/;

const MAX_URL = 2048;
const MAX_HOST = 253;

/**
 * What may be masked, and how long a run has to be before it counts.
 *
 * The bounds on the two numbers are not repeated here. `parseRedactionPolicy` owns them and
 * says what they are in its refusal; a second copy in this schema is a second copy to drift.
 */
const redaction = object({
  categories: list(choice(REDACTION_CATEGORIES), { maxItems: REDACTION_CATEGORIES.length }),
  /** Shortest written digit run `digit-sequence` masks. */
  minDigits: optional(integer({ minimum: 2 })),
  /** Shortest spoken digit run `spoken-digit-sequence` masks. */
  minSpokenDigits: optional(integer({ minimum: 2 })),
});

const subscription = object({
  /** This organisation's own name for the receiver. It appears in the delivery log. */
  name: text({ minLength: 1, maxLength: 100 }),
  url: text({ minLength: 1, maxLength: MAX_URL, format: "uri" }),
  events: list(choice(EVENT_TYPES), { maxItems: EVENT_TYPES.length }),
  /**
   * The shared secret this receiver verifies the signature with. Required, deliberately:
   * an endpoint that accepts an unsigned POST accepts one from anybody who learns the URL.
   * It must be a credential stored with `kind: signing`; an auth credential is refused.
   */
  signingSecretRef: text({ maxLength: 64, pattern: CREDENTIAL_REF }),
  /** Optional auth on top of the signature, for a receiver that wants a header too. */
  credentialRef: optional(text({ maxLength: 64, pattern: CREDENTIAL_REF })),
  /** How long one attempt may take. Nobody is on the line, so this is generous. */
  timeoutMs: optional(integer({ minimum: 1 })),
  /** Attempts before the delivery is given up on and recorded as failed. */
  maxAttempts: optional(integer({ minimum: 1 })),
  /** This receiver's rules, overriding the organisation's for this receiver alone. */
  redaction: optional(redaction),
});

const egress = object({
  allowedHosts: list(text({ minLength: 1, maxLength: MAX_HOST }), { maxItems: 100 }),
  allowPlaintextHttp: optional(flag()),
});

const configurationFields = {
  egress,
  /** The organisation's default. Absent means nothing is masked anywhere. */
  redaction: optional(redaction),
  subscriptions: list(subscription, { maxItems: 50 }),
} as const;

const eventConfiguration = object({
  configVersion: integer({ minimum: 0 }),
  ...configurationFields,
});

const replacement = object({
  /** The `configVersion` this edit was made against. See the tools endpoint for why. */
  expectedVersion: integer({ minimum: 0 }),
  note: optional(text({ minLength: 1, maxLength: 200 })),
  ...configurationFields,
});

const published = object({ configVersion: integer({ minimum: 1 }) });

const DEFAULT_NOTE = "dashboard: event configuration replaced";

type RedactionInput = Infer<typeof redaction>;

const redactionPart = (policy: RedactionInput | undefined): Record<string, unknown> =>
  policy === undefined
    ? {}
    : {
        redaction: {
          categories: policy.categories,
          ...(policy.minDigits === undefined ? {} : { minDigits: policy.minDigits }),
          ...(policy.minSpokenDigits === undefined
            ? {}
            : { minSpokenDigits: policy.minSpokenDigits }),
        },
      };

const redactionOut = (policy: RedactionPolicy): RedactionInput => ({
  categories: policy.categories,
  minDigits: policy.minDigits,
  minSpokenDigits: policy.minSpokenDigits,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * Which redaction rules the stored document actually *declared*, as opposed to resolved.
 *
 * `parseEventConfig` fills every subscription's `redaction` in — from the organisation's
 * default, or from `NO_REDACTION` — because the delivery path wants one value to read and
 * no inheritance to work out at 3am. Reporting that resolved value as though the receiver
 * had written it would turn "this receiver inherits" into "this receiver overrides with the
 * same thing", and the next `PUT` would freeze the inheritance: a receiver added afterwards
 * would quietly stop picking up the organisation's default.
 *
 * So the parsed config supplies the values and the raw document supplies which of them the
 * tenant wrote. The subscription array is in the same order in both, because the parser
 * maps over it.
 */
interface Declared {
  readonly tenant: boolean;
  readonly bySubscription: readonly boolean[];
}

const declaredRedaction = (stored: unknown): Declared => {
  const raw = asRecord(stored);
  const subscriptions = Array.isArray(raw?.subscriptions) ? (raw.subscriptions as unknown[]) : [];
  const present = (value: unknown): boolean => value !== undefined && value !== null;
  return {
    tenant: present(raw?.redaction),
    bySubscription: subscriptions.map((entry) => present(asRecord(entry)?.redaction)),
  };
};

/** The request body, as the document that goes in the column. */
export const toEventDocument = (body: Infer<typeof replacement>): Record<string, unknown> => ({
  egress: {
    allowedHosts: body.egress.allowedHosts,
    ...(body.egress.allowPlaintextHttp === undefined
      ? {}
      : { allowPlaintextHttp: body.egress.allowPlaintextHttp }),
  },
  ...redactionPart(body.redaction),
  subscriptions: body.subscriptions.map((entry) => ({
    name: entry.name,
    url: entry.url,
    events: entry.events,
    signingSecretRef: entry.signingSecretRef,
    ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.maxAttempts === undefined ? {} : { maxAttempts: entry.maxAttempts }),
    ...redactionPart(entry.redaction),
  })),
});

/**
 * The parsed document, as the response.
 *
 * Takes the raw column as well as the parsed form, and only for the question above: which
 * redaction rules were written down and which were inherited. Everything else comes from
 * the parsed form, which is normalised and typed.
 */
export const toEventResponseBody = (
  parsed: EventConfig,
  stored: unknown,
): Omit<Infer<typeof eventConfiguration>, "configVersion"> => {
  const declared = declaredRedaction(stored);
  const tenantPolicy = parseRedactionPolicy(asRecord(stored)?.redaction, "redaction");

  return {
    egress: {
      allowedHosts: parsed.egress.allowedHosts,
      ...(parsed.egress.allowPlaintextHttp === true ? { allowPlaintextHttp: true } : {}),
    },
    ...(declared.tenant ? { redaction: redactionOut(tenantPolicy) } : {}),
    subscriptions: parsed.subscriptions.map((entry, index) => ({
      name: entry.name,
      url: entry.url,
      events: entry.events,
      signingSecretRef: entry.signingSecretRef,
      ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
      timeoutMs: entry.timeoutMs,
      maxAttempts: entry.maxAttempts,
      ...(declared.bySubscription[index] === true
        ? { redaction: redactionOut(entry.redaction) }
        : {}),
    })),
  };
};

@Controller(apiRoute("event-subscriptions"))
export class EventSubscriptionsController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "Where this organisation's calls are pushed, and what is masked on the way",
    description:
      "Each receiver carries the redaction rules that will actually apply to it, resolved from the organisation's default. A receiver that masks nothing reports no redaction, because nothing is masked unless it is asked for.",
    capability: "config:read",
    response: eventConfiguration,
  })
  async read(): Promise<Infer<typeof eventConfiguration>> {
    return this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      if (current === null) throw new NotFoundException();

      const parsed = orConflict(() => parseEventConfig(current.eventConfig));
      return {
        configVersion: current.configVersion,
        ...toEventResponseBody(parsed, current.eventConfig),
      };
    });
  }

  @Put()
  @Endpoint({
    summary: "Replace where this organisation's calls are pushed",
    description:
      "Whole document, never a patch, and it publishes a new configuration version — which is what records the redaction rules a payload left under. Refused with 422 if a receiver names an unknown event, has no signing secret, sits outside egress.allowedHosts, or points at a credential this organisation has not stored or has stored as the other kind.",
    capability: "config:write",
    body: replacement,
    response: published,
  })
  async replace(@FromBody() body: Infer<typeof replacement>): Promise<Infer<typeof published>> {
    const document = toEventDocument(body);
    const events = orRefuse(() => checkEventConfig(document));

    return this.db.tx(async (scope) => {
      const current = await readConfiguration(scope);
      if (current === null) throw new NotFoundException();
      if (current.configVersion !== body.expectedVersion) {
        throw new ConflictException(
          `this organisation's configuration is at version ${current.configVersion} and the edit was made against ${body.expectedVersion}; re-read it and try again`,
        );
      }

      const sealed = await sealedCredentials(scope);
      const key = vaultKey();
      const kinds = key === null ? null : await classifyCredentials(key, scope.tenantId, sealed);
      const uses = credentialUses(toolsOrNothing(current.toolConfig), events);
      orRefuse(() => refuseUnusableReferences(uses, new Set(sealed.keys()), kinds));

      const version = await publishConfiguration(scope, current, {
        // Carried over untouched, for the same reason the tools endpoint carries this one.
        toolConfig: current.toolConfig,
        eventConfig: document,
        note: body.note ?? DEFAULT_NOTE,
      });
      return { configVersion: version };
    });
  }
}
