import { liveAgentId, loadOnboardingFacts } from "@ansa/db";
import { Controller, Get, Inject } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { apiRoute } from "../http/request";
import { choice, flag, list, nullable, object, text, type Infer } from "../http/schema";
import { OrganizationContext } from "../tenancy/organization-context";

import { expectedVoiceWebhookUrl, loadNumbersEnvironment } from "./environment";
import { carrierDirectoryFor, probeCarrierWebhook } from "./probes";
import { clamp } from "./text";

/**
 * The organisation's phone numbers, and the honest account of how it gets one.
 *
 * **This area is read-only, and that is a decision rather than an omission.**
 *
 * "Claim a number" is the first thing a Nigerian organisation asks for and the one thing
 * this platform cannot give them: the carrier it has an account with sells no Nigerian
 * inventory. A claim endpoint would be a button that always fails, so there is none, and
 * `GET /numbers/provisioning` says so in a form a dashboard can render.
 *
 * "Attach a number I already own" is the useful half of that, and it is not here either.
 * `organizations.dialled_number` is the ingress routing table — `app.organization_for_number` resolves
 * every inbound call through it — and `docs/ORGANIZATION_CONFIGURATION.md` §5 keeps it out of the
 * organisation's reach for a concrete reason: an organisation that could write it could
 * claim a number nobody assigned it. The unique index stops two organisations holding the
 * same number, but nothing stops the *first* claim on a number somebody else controls at
 * their carrier, and the next organization to be onboarded onto it would find it taken and their
 * calls answered by a stranger's agent.
 *
 * Making that safe needs proof that the organisation controls the number, and there is
 * none available: the carrier cannot vouch for a number it does not sell, and a
 * verification call is a different task with its own consent question. The shape it would
 * take is written down in the report for this work — a per-organisation token the
 * organisation puts in the voice webhook they configure at their own carrier, which is the
 * telephony equivalent of a DNS TXT record and which they can only do if they hold the
 * number. Until something like that exists, attaching is an operator's job, and this
 * endpoint's job is to say so instead of failing obscurely.
 */

/**
 * The bounds below are enforced on the way out as well as declared here.
 *
 * `organizations.dialled_number` is an unconstrained text column written by an operator in psql,
 * and a URL comes back from a carrier. The interceptor answers 500 when a handler returns
 * something its own schema rejects, so a number typed with a paragraph in it would take
 * this endpoint down rather than being shown as the mistake it is.
 */
const NUMBER_LIMIT = 64;
const URL_LIMIT = 2048;

const carrierWebhook = object({
  state: choice([
    "matches",
    "points-elsewhere",
    "not-set",
    "not-in-carrier-account",
    "unchecked",
  ]),
  /** Where the carrier must be pointed. Null when this process cannot state its own address. */
  expected: nullable(text({ maxLength: URL_LIMIT })),
  /** What the carrier actually has. Null unless the platform's own account holds the number. */
  observed: nullable(text({ maxLength: URL_LIMIT })),
  reason: nullable(text({ maxLength: 400 })),
});

const attachedNumber = object({
  number: text({ maxLength: NUMBER_LIMIT }),
  /**
   * Constant today, and named rather than assumed. Ansa answers calls and does not place
   * them; a second value here would be a feature gated behind Slice 7a, not a field.
   */
  use: choice(["inbound"]),
  /** Who may change the attachment. See the file comment for why it is never the organisation. */
  managedBy: choice(["operator"]),
  carrierWebhook,
});

/**
 * Not a keyset page, and not by oversight.
 *
 * A page exists because a list is long and written to constantly, and one number per
 * organisation is neither. `organizations.dialled_number` is a single column; a cursor over it
 * would be a contract promising growth this schema cannot deliver, and it would have to be
 * broken on the day a numbers table arrives anyway.
 */
const numberList = object({ items: list(attachedNumber) });

const provisioning = object({
  /** The carrier this deployment can read. Null when it holds no carrier credentials. */
  carrier: nullable(text({ maxLength: 32 })),
  claim: object({
    available: flag(),
    reason: choice(["no-nigerian-inventory"]),
    detail: text({ maxLength: 800 }),
  }),
  attach: object({
    selfService: flag(),
    reason: choice(["operator-owned-ingress"]),
    detail: text({ maxLength: 800 }),
  }),
  voiceWebhook: object({
    /** Null when this process does not know its own public address. */
    url: nullable(text({ maxLength: 2048 })),
    method: choice(["POST"]),
    detail: text({ maxLength: 800 }),
  }),
});

const CLAIM_DETAIL =
  "A number cannot be bought through this API. The carrier this platform holds an account with sells no Nigerian numbers, so there is no inventory to offer and no endpoint that would succeed. Bring a number you already hold with your own carrier.";

const ATTACH_DETAIL =
  "A number is attached by an operator, not from here. The attached number is the ingress routing table for every inbound call on this deployment, and nothing yet proves that an organisation controls the number it asks for — so a self-service attach could take a number belonging to somebody who has not been onboarded onto it. Send the number to your operator.";

const WEBHOOK_DETAIL =
  "Configure this at your carrier as the number's voice webhook. Until it is set, the number rings nowhere and every other part of the configuration will still look correct.";

@Controller(apiRoute("numbers"))
export class NumbersController {
  constructor(@Inject(OrganizationContext) private readonly db: OrganizationContext) {}

  @Get()
  @Endpoint({
    summary: "List the numbers attached to this organisation",
    description:
      "At most one today: an inbound call is resolved by the number that was dialled, and one organisation holds one. Each entry carries the carrier's own record of where that number sends calls, which is unreadable — and reported as unchecked — for a number held at a carrier this deployment has no account with.",
    capability: "config:read",
    response: numberList,
  })
  async list(): Promise<Infer<typeof numberList>> {
    /* Organisation-scoped, so it resolves rather than naming an agent — and `liveAgentId`
       raises on two rather than picking one (migration 0047). Worth saying plainly what this
       leaves owed: the endpoint describes itself as the organisation's numbers and answers
       with one agent's, which is the same shape of wrong that `config.*` had before it was
       made agent-scoped. The real source is `organization_numbers`, and moving it there is a
       change to what this returns rather than to how it resolves. */
    const number = await this.db.tx(async (scope) => {
      const agentId = await liveAgentId(scope);
      if (agentId === null) return null;
      const facts = await loadOnboardingFacts(scope, agentId);
      return facts?.dialledNumber ?? null;
    });
    if (number === null) return { items: [] };

    const environment = loadNumbersEnvironment();
    const webhook = await probeCarrierWebhook(
      environment,
      number,
      carrierDirectoryFor(environment),
    );

    return {
      items: [
        {
          number: clamp(number, NUMBER_LIMIT),
          use: "inbound",
          managedBy: "operator",
          carrierWebhook: {
            state: webhook.state,
            expected: webhook.expected === null ? null : clamp(webhook.expected, URL_LIMIT),
            observed: webhook.observed === null ? null : clamp(webhook.observed, URL_LIMIT),
            reason: webhook.reason,
          },
        },
      ],
    };
  }

  @Get("provisioning")
  @Endpoint({
    summary: "What this organisation can and cannot do to get a number",
    description:
      "Two things are unavailable and both are stated here rather than discovered as a failing request: a number cannot be bought through this API, because the carrier sells no Nigerian inventory; and a number cannot be attached self-service, because the attached number routes every inbound call on the deployment and nothing yet proves an organisation controls the number it names. The webhook URL is this deployment's real ingress address, which is the value an operator needs at the carrier.",
    capability: "config:read",
    response: provisioning,
  })
  provisioning(): Infer<typeof provisioning> {
    const environment = loadNumbersEnvironment();
    return {
      carrier: carrierDirectoryFor(environment)?.name ?? null,
      claim: { available: false, reason: "no-nigerian-inventory", detail: CLAIM_DETAIL },
      attach: { selfService: false, reason: "operator-owned-ingress", detail: ATTACH_DETAIL },
      voiceWebhook: {
        url: expectedVoiceWebhookUrl(environment)?.slice(0, URL_LIMIT) ?? null,
        method: "POST",
        detail: WEBHOOK_DETAIL,
      },
    };
  }
}
