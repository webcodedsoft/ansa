import { loadCurrentTenantConfig } from "@ansa/db";
import {
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Post,
  UnprocessableEntityException,
} from "@nestjs/common";

import { ConsentError } from "../../outbound/place";
import { Endpoint } from "../http/endpoint";
import { apiRoute, FromBody } from "../http/request";
import { integer, object, text, type Infer } from "../http/schema";
import { phoneNumber } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

import { ORIGINATION, type Origination } from "./origination";

/**
 * Ring your own phone and hear what you just published.
 *
 * The gap this closes is between "I changed a prompt" and "I know whether it is better".
 * Every defect this project has found was hiding in that gap, and the readiness endpoint
 * next door says out loud that it cannot close it: every check there is a read, and no
 * amount of reading tells you what the agent sounds like.
 *
 * ---
 *
 * **Consent is not waived for a test, and there is no flag here that waives it.**
 *
 * The organisation must already have consent on record for the number being dialled, or the
 * call is refused with the reason. This is the decision most worth understanding, because
 * the counter-argument is obvious — it is their own phone, they are testing their own agent,
 * asking them for a consent record is bureaucracy.
 *
 * It is not, for two reasons. The first is that this endpoint cannot tell whose phone it is.
 * "The organisation's own number" is a claim in a request body; a consent record is evidence
 * somebody wrote down before the call was contemplated, which is precisely the difference
 * between the two and precisely why `grant-consent.mjs` is a separate tool from
 * `place-call.mjs`. The second is that a gate with one exemption has an exemption-shaped
 * hole in it: a "test" flag that skips the check makes the check a matter of which endpoint
 * you call, and the endpoint without it is the one with a button on it.
 *
 * So this goes through `placeOutboundCall` like everything else, and the verdict comes back
 * from `outbound/consent.ts` unchanged — including the calling-hours window, which is
 * clamped to 08:00–20:00 WAT no matter what the organisation configured. A test call at ten
 * at night is refused, and that is correct: somebody's phone rings either way.
 *
 * **If a verified-own-number flow is wanted, it is recorded consent with its own basis.**
 * The shape is already there: `outbound_consent.basis` is free text on purpose, so a number
 * proven to belong to the organisation — by sending it a code and having the code typed back
 * — is a consent row whose basis says so, granted at the moment the proof happened.
 * Everything below then works unchanged, because it was never asking about the destination;
 * it was asking whether there is evidence. That flow needs a verification channel this
 * product does not have yet, which is why it is described here rather than half-built.
 *
 * ---
 *
 * **Queued is not answered.** `placeCall` returns when the carrier accepts the request. The
 * phone has not rung, nobody has picked up, and the agent has not said anything. Everything
 * after this point arrives through the machinery that already exists: the status callbacks
 * on `/telephony/status`, the media stream, the `calls` row, the event log, and — a few
 * seconds later — `GET /calls/{id}` with the turns in it. Returning the carrier's own word
 * for the state rather than inventing a friendlier one is what keeps that honest.
 *
 * **The call comes from the organisation's own number**, the one the operator assigned them
 * and the one their callers dial. Not an environment variable: a platform-wide "from" would
 * put an unfamiliar number on the screen of somebody testing whether their own line works,
 * and the carrier account owns their number already because it is the number it routes.
 */

const testCall = object({
  /**
   * Where to ring. Required, with no default and no "my own number" shorthand — the
   * organisation's dialled number is an inbound route, and dialling it would ring the agent
   * rather than a person.
   */
  to: phoneNumber(),
});

const placed = object({
  /**
   * The carrier's id for the call, which is `calls.carrier_call_id` once the call arrives.
   * The way to find this call again in the call list.
   */
  carrierCallId: text({ maxLength: 128 }),
  /**
   * The carrier's own word: `queued`, `initiated`, `ringing`. Deliberately passed through
   * rather than mapped onto something of ours — none of them means "answered", and a
   * friendlier word would imply one of them does.
   */
  status: text({ maxLength: 32 }),
  to: phoneNumber(),
  from: phoneNumber(),
  /**
   * The configuration version this call will be answered on, read at the moment it was
   * placed. The point of the exercise: it is what `GET /config/versions/{version}` and the
   * `configVersion` on the finished call both refer to.
   */
  configVersion: integer({ minimum: 0 }),
});

@Controller(apiRoute("test-calls"))
export class TestCallController {
  constructor(
    @Inject(TenantContext) private readonly db: TenantContext,
    @Inject(ORIGINATION) private readonly origination: Origination,
  ) {}

  @Post()
  @Endpoint({
    summary: "Ring a number and let this organisation's agent answer it",
    description:
      "Placed from the organisation's own number, through the same consent gate every " +
      "outbound call goes through: refused with 422 and the reason if the destination has no " +
      "consent on record, is on the do-not-call list, or it is outside calling hours. There " +
      "is no flag that skips that. Answers 202 with the carrier's own status — the call is " +
      "queued, not answered — and everything after that shows up on the call itself.",
    capability: "config:write",
    body: testCall,
    response: placed,
    status: 202,
    // A button somebody can hold down rings a real telephone. Keyed by address, which is
    // all this can express; the consent record is what bounds *which* phone.
    rateLimit: { limit: 10, windowMs: 10 * 60_000, by: "ip" },
  })
  async place(@FromBody() body: Infer<typeof testCall>): Promise<Infer<typeof placed>> {
    const current = await this.db.tx((scope) => loadCurrentTenantConfig(scope));
    // The session outliving a deleted organisation, as everywhere else on this surface.
    if (current === null) throw new NotFoundException();

    const from = current.operatorManaged.dialledNumber;
    if (from === null) {
      throw new ConflictException(
        "this organisation has no number assigned to it yet, so there is nothing to call " +
          "from. An operator assigns one; see the readiness endpoint for what else is " +
          "outstanding.",
      );
    }

    try {
      const call = await this.origination.place({
        owner: this.db.caller.tenantId,
        to: body.to,
        from,
      });
      return {
        carrierCallId: call.callId,
        status: call.status,
        to: body.to,
        from,
        configVersion: current.version,
      };
    } catch (error) {
      // 422 rather than 403: the request was well-formed and the caller is allowed to place
      // test calls — what is missing is a fact about the destination, which is a thing they
      // can go and record. The reason is `consent.ts`'s own sentence, which names which of
      // the four refusals it was.
      if (error instanceof ConsentError) {
        throw new UnprocessableEntityException(
          `${error.message}. Consent is evidence recorded before the call, and a test is not ` +
            "an exception to it — see tools/outbound/grant-consent.mjs.",
        );
      }
      throw error;
    }
  }
}
