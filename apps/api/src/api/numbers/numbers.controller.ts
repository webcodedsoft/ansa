import { randomBytes } from "node:crypto";

import { listHeldNumbers, readClaimToken, setClaimToken } from "@ansa/db";
import { Controller, Get, Inject, NotFoundException, Post } from "@nestjs/common";

import { uuid } from "../schemas";
import { Endpoint } from "../http/endpoint";
import { apiRoute } from "../http/request";
import { choice, flag, list, nullable, object, text, type Infer } from "../http/schema";
import { OrganizationContext } from "../tenancy/organization-context";

import { expectedVoiceWebhookUrl, loadNumbersEnvironment, VOICE_WEBHOOK_PATH } from "./environment";
import { carrierDirectoryFor, probeCarrierWebhook } from "./probes";
import { clamp } from "./text";

/**
 * The organisation's phone numbers, and the honest account of how it gets one.
 *
 * **Attaching is self-service now, and the proof is a phone call.** This header used to say
 * the opposite — that the area was read-only by design, because nothing could prove an
 * organisation controlled the number it named, and an organisation that could write the
 * routing table could claim a line somebody else holds at their own carrier. That reasoning
 * was right and the gap it described is closed rather than reopened.
 *
 * It closed by building the mechanism this file already specified: a per-organisation token
 * the organisation puts in the voice webhook it configures at its own carrier, "the telephony
 * equivalent of a DNS TXT record and which they can only do if they hold the number".
 * `GET /numbers/webhook` mints and returns that URL; a call arriving on it attaches the
 * number; migration 0054 has the full argument and `app.claim_number_with_token` is the only
 * hole in the SELECT-only grant that 0019 established.
 *
 * Two things did not change. A number somebody else has already proved is refused rather than
 * moved, because proving control today does not entitle you to take a line off whoever proved
 * it yesterday — porting stays an operator's job. And **buying** a number is still impossible:
 * the carrier this deployment holds an account with sells no Nigerian inventory, so
 * `claim.available` is still false and `GET /numbers/provisioning` still says why in a form a
 * dashboard can render. That is a different sentence from "you cannot bring your own", and the
 * two used to be muddled together.
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
  /**
   * Which agent answers this number, or null when the organisation holds it and nothing does.
   *
   * The null is the useful half. A number attached at the carrier that no agent answers rings
   * nowhere, and it is invisible from every other screen — the agent list shows agents, not
   * spare numbers.
   */
  answeredBy: nullable(object({ agentId: uuid(), name: text({ maxLength: 200 }) })),
  carrierWebhook,
});

/**
 * Not a keyset page, and not by oversight.
 *
 * A page exists because a list is long and written to constantly, and an operator-assigned
 * number list is neither: it changes when somebody at the carrier changes it, which is rarely
 * and by hand. A cursor here would be a contract promising growth this table will not deliver.
 */
const numberList = object({ items: list(attachedNumber) });

/**
 * The URL and nothing else. The token is inside it and is never returned on its own.
 *
 * `url` is null in two situations that need different answers on screen, which is why
 * `addressable` exists rather than the caller inferring one from the other. No token yet is
 * ordinary and the remedy is a button; no public address is an operator's misconfiguration and
 * the remedy is not on this page. Collapsing them meant a fresh organisation being told its
 * deployment was broken.
 */
const claimWebhook = object({
  url: nullable(text({ maxLength: URL_LIMIT })),
  /** Whether this process knows its own public address. False is nothing the reader can fix. */
  addressable: flag(),
  method: choice(["POST"]),
});

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
    /* `prove-by-webhook` since migration 0054: attaching is self-service now, and the proof is
       that a call arrives on a URL only the number's holder could have configured. */
    reason: choice(["operator-owned-ingress", "prove-by-webhook"]),
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
  "Point your carrier's voice webhook at the URL below and call the number once. The call proves you hold it — only the holder can say where a number sends its calls — and the number attaches itself. Nothing is typed in, because a number somebody types is a number they might not own.";

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
    /* `organization_numbers`, which is what the endpoint's name has always claimed. It used
       to read one agent's `dialled_number` through the readiness facts — so an organisation
       holding three numbers saw one, and a number attached at the carrier that no agent
       answers yet appeared nowhere at all. That last state is the one an operator most needs
       during onboarding, and it was the one the old query could not express. */
    const held = await this.db.tx((scope) => listHeldNumbers(scope));
    if (held.length === 0) return { items: [] };

    const environment = loadNumbersEnvironment();
    const directory = carrierDirectoryFor(environment);
    /* One probe per number, together. They are independent reads against the carrier and
       running them in series would put one timeout behind another on a page somebody is
       watching — the same reason the readiness probes run in parallel. */
    const webhooks = await Promise.all(
      held.map((entry) => probeCarrierWebhook(environment, entry.number, directory)),
    );

    return {
      items: held.map((entry, index) => {
        const webhook = webhooks[index];
        return {
          number: clamp(entry.number, NUMBER_LIMIT),
          use: "inbound" as const,
          managedBy: "operator" as const,
          answeredBy:
            entry.agentId === null || entry.agentName === null
              ? null
              : { agentId: entry.agentId, name: clamp(entry.agentName, 200) },
          carrierWebhook: {
            state: webhook?.state ?? "unchecked",
            expected: webhook?.expected == null ? null : clamp(webhook.expected, URL_LIMIT),
            observed: webhook?.observed == null ? null : clamp(webhook.observed, URL_LIMIT),
            reason: webhook?.reason ?? null,
          },
        };
      }),
    };
  }

  /**
   * The URL this organisation points its carrier at, secret and all.
   *
   * `config:write`, unlike everything else on this surface, and the difference is the point: a
   * reader with `config:read` is a member who can see what the agent says, and this value is a
   * bearer secret that attaches numbers. It is the one thing here that is not safe to show
   * everybody who can see the page it belongs on.
   *
   * Answers null until somebody asks for one. Minting is `POST webhook/rotate`, so an
   * organisation that never imports a number never has a secret to leak — and opening a page
   * is never a write.
   */
  @Get("webhook")
  @Endpoint({
    summary: "The webhook URL to configure at your carrier, including this organisation's secret",
    description:
      "Point a number's voice webhook here at whichever provider sold it to you, then call the number once. The call proves you hold it and the number attaches itself — only the holder of a number can decide where it sends its calls. Treat the URL as a password: anyone who has it can attach numbers to this organisation. Rotate it if it leaks; numbers already attached stay attached.",
    capability: "config:write",
    response: claimWebhook,
  })
  async webhook(): Promise<Infer<typeof claimWebhook>> {
    /* A read, and only a read. An earlier version minted on first GET, which was convenient
       and wrong twice over: it made opening a page a write, and it meant every organisation
       ended up holding a secret whether or not it ever imported a number — the opposite of
       what migration 0054 promises. Null here means "none yet", and the caller asks for one. */
    const token = await this.db.tx((scope) => readClaimToken(scope));
    return {
      url: this.claimUrl(token),
      addressable: loadNumbersEnvironment().publicBaseUrl !== null,
      method: "POST",
    };
  }

  @Post("webhook/rotate")
  @Endpoint({
    summary: "Create or replace the secret in the webhook URL",
    description:
      "Also how the first one is created: there is no separate generate step, because minting and replacing are the same act. The old URL stops working the moment this returns and every number already attached stays attached — but a carrier still pointing at the old URL stops reaching this organisation, so have their settings open before you rotate.",
    capability: "config:write",
    response: claimWebhook,
    status: 201,
  })
  async rotate(): Promise<Infer<typeof claimWebhook>> {
    /* 32 bytes from the platform's own randomness rather than a database default, and this is
       the only place a token is ever minted — which is what makes "never logged" a property
       somebody can check rather than a hope. */
    const minted = randomBytes(32).toString("hex");
    const saved = await this.db.tx((scope) => setClaimToken(scope, minted));
    if (!saved) throw new NotFoundException();
    return {
      url: this.claimUrl(minted),
      addressable: loadNumbersEnvironment().publicBaseUrl !== null,
      method: "POST",
    };
  }

  /** Null when there is no token, or when this process does not know its own address. */
  private claimUrl(token: string | null): string | null {
    const base = loadNumbersEnvironment().publicBaseUrl;
    if (token === null || base === null) return null;
    return clamp(`${base}${VOICE_WEBHOOK_PATH}/${token}`, URL_LIMIT);
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
      attach: { selfService: true, reason: "prove-by-webhook", detail: ATTACH_DETAIL },
      voiceWebhook: {
        url: expectedVoiceWebhookUrl(environment)?.slice(0, URL_LIMIT) ?? null,
        method: "POST",
        detail: WEBHOOK_DETAIL,
      },
    };
  }
}
