import {
  EVENT_TYPES,
  parseEventConfig,
  type EventConfig,
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
import { OrganizationContext } from "../tenancy/organization-context";

import { checkEventConfig, orConflict, orRefuse, toolsOrNothing } from "./refusals";
import { publishConfiguration, readConfiguration, sealedCredentials } from "./store";
import { classifyCredentials, credentialUses, refuseUnusableReferences, vaultKey } from "./vault";

/**
 * Where an organisation's own calls get pushed to.
 *
 * Not a tool, and the difference is not cosmetic — see `packages/tools/src/events/config.ts`.
 * A tool call is decided by the model mid-conversation on a three-second budget; a delivery
 * is decided by the platform after the fact and cannot touch a call. They are two documents
 * and two validators, and they share only the things below the seam: the egress allowlist,
 * the credential vault and the guarded transport.
 *
 * **No caller value is masked, ever.** R5.2.4 offered per-organisation and per-receiver
 * masking of names, identifiers and digit runs; it was withdrawn on 2026-08-15 and the
 * engine deleted. The organisation is the data controller, the caller is their customer,
 * and the payload is a record of a conversation their own agent had. Deciding on their
 * behalf which of their own data they may receive was never ours to make, and it broke the
 * obvious uses — the CRM that needs the policy number, the ticketing system that needs the
 * callback number. A `redaction` block in a stored document is ignored rather than
 * rejected, so an organisation that saved one still gets its events.
 *
 * Credential-shaped keys are stripped from every payload unconditionally, and that is not
 * a field on this document in either direction. It is not the organisation's data; it is
 * material held in trust (R5.2.1), and it is the one rule no configuration reaches.
 */

const CREDENTIAL_REF = /^[a-z][a-z0-9_]{1,63}$/;

const MAX_URL = 2048;
const MAX_HOST = 253;

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
});

const egress = object({
  allowedHosts: list(text({ minLength: 1, maxLength: MAX_HOST }), { maxItems: 100 }),
  allowPlaintextHttp: optional(flag()),
});

const configurationFields = {
  egress,
  /** The organisation's default. Absent means nothing is masked anywhere. */
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

/** The request body, as the document that goes in the column. */
export const toEventDocument = (body: Infer<typeof replacement>): Record<string, unknown> => ({
  egress: {
    allowedHosts: body.egress.allowedHosts,
    ...(body.egress.allowPlaintextHttp === undefined
      ? {}
      : { allowPlaintextHttp: body.egress.allowPlaintextHttp }),
  },
  subscriptions: body.subscriptions.map((entry) => ({
    name: entry.name,
    url: entry.url,
    events: entry.events,
    signingSecretRef: entry.signingSecretRef,
    ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.maxAttempts === undefined ? {} : { maxAttempts: entry.maxAttempts }),
  })),
});

/**
 * The parsed document, as the response.
 *
 * It used to take the raw column too, to report which redaction rules an organisation had
 * written down as opposed to inherited. With R5.2.4 withdrawn there is no such question,
 * and everything comes from the parsed form, which is normalised and typed.
 */
export const toEventResponseBody = (
  parsed: EventConfig,
): Omit<Infer<typeof eventConfiguration>, "configVersion"> => {
  return {
    egress: {
      allowedHosts: parsed.egress.allowedHosts,
      ...(parsed.egress.allowPlaintextHttp === true ? { allowPlaintextHttp: true } : {}),
    },
    subscriptions: parsed.subscriptions.map((entry) => ({
      name: entry.name,
      url: entry.url,
      events: entry.events,
      signingSecretRef: entry.signingSecretRef,
      ...(entry.credentialRef === undefined ? {} : { credentialRef: entry.credentialRef }),
      timeoutMs: entry.timeoutMs,
      maxAttempts: entry.maxAttempts,
    })),
  };
};

@Controller(apiRoute("event-subscriptions"))
export class EventSubscriptionsController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "Where this organisation's calls are pushed",
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
        ...toEventResponseBody(parsed),
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
      const kinds = key === null ? null : await classifyCredentials(key, scope.organizationId, sealed);
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
