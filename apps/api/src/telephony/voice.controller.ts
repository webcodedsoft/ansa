import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
} from "@nestjs/common";
import { closeCallByCarrierId, recordCallEventByCarrierId, type Db } from "@ansa/db";
import { asCallId } from "@ansa/shared";
import type { Logger } from "@ansa/shared";
import { wasAnswered, type TelephonyProvider } from "@ansa/telephony";

import type { AppConfig } from "../config/env";
import { MediaGateway } from "./media.gateway";
import type { AgentRegistry } from "../tenancy/agent-registry";
import {
  APP_CONFIG,
  LOGGER,
  AMD_WEBHOOK_PATH,
  CALLER_PARAM,
  DIALLED_PARAM,
  DIRECTION_PARAM,
  STATUS_WEBHOOK_PATH,
  DATA_SOURCE,
  MEDIA_STREAM_PATH,
  TELEPHONY_PROVIDER,
  ORGANIZATION_PARAM,
  ORGANIZATION_REGISTRY,
  VOICE_WEBHOOK_PATH,
} from "./tokens";

/** Structural view of the platform response object, so no HTTP vendor type appears here. */
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

@Controller("telephony")
export class VoiceController {
  constructor(
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly log: Logger,
    @Inject(ORGANIZATION_REGISTRY) private readonly organizations: AgentRegistry,
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    // Injected by class rather than by token, and with an explicit @Inject so the import
    // stays a runtime value: Nest resolves a constructor parameter from emitted metadata,
    // and `import type` would erase it to Object and break the injection at boot rather
    // than at compile time.
    @Inject(MediaGateway) private readonly media: MediaGateway,
  ) {}

  @Post("voice")
  // Nest answers POST with 201 by default. The carrier expects 200 for TwiML and
  // treats anything else as a failed webhook, which drops the call.
  @HttpCode(HttpStatus.OK)
  async answer(
    @Body() body: unknown,
    @Headers("x-twilio-signature") signature: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<string> {
    const verified = this.telephony.verifyWebhook({
      url: `${this.config.publicBaseUrl}${VOICE_WEBHOOK_PATH}`,
      params: body,
      signature: signature ?? null,
    });

    if (!verified) {
      this.log.warn("rejected unsigned inbound call webhook");
      throw new ForbiddenException();
    }

    const call = this.telephony.parseInboundCall(body);
    const log = this.log.child({ callId: call.callId });
    log.info("inbound call", { dialled: call.dialled, caller: call.caller });

    // Resolved here, before anything else happens (R7.3). The media socket carries no
    // dialled number, so it travels to it as a stream parameter.
    const organization = await this.organizations.resolve(call.dialled);
    log.info("organization resolved", {
      organizationId: organization.organizationId,
      name: organization.name,
      configVersion: organization.configVersion,
      keyterms: organization.keyterms.length,
    });

    // Their voice may not be the platform's, and rendering a greeting was measured at
    // 959ms cold. Started here and never awaited: the carrier is waiting for this TwiML,
    // and the media socket that will use the audio does not open until it has it. If the
    // render has not finished by then the call synthesises live, which is slower and
    // audible rather than silent (R6.2).
    this.media.warmForOrganization(organization);

    /* And who this caller is to us, on the same terms and for the same reason. The greeting
       is the one line that can say "hi again", and it plays before the media socket has had
       time to ask anything — so the asking has to start here. Never awaited: the carrier is
       waiting for this TwiML. */
    /* Null for an unregistered number, and there is nothing to look up: no organisation
       means no call log to have been in. */
    if (organization.organizationId !== null) {
      this.media.warmCallerHistory(organization.organizationId, call.caller, call.callId);
    }

    const wsOrigin = this.config.publicBaseUrl.replace(/^http/, "ws");
    const answer = this.telephony.renderAnswer({
      mediaStreamUrl: `${wsOrigin}${MEDIA_STREAM_PATH}`,
      parameters: {
        [DIRECTION_PARAM]: "inbound",
        [DIALLED_PARAM]: call.dialled,
        ...(call.caller === null ? {} : { [CALLER_PARAM]: call.caller }),
        ...(organization.organizationId === null ? {} : { [ORGANIZATION_PARAM]: organization.organizationId }),
      },
    });

    res.setHeader("Content-Type", answer.contentType);
    return answer.body;
  }

  /**
   * The carrier's verdict on what answered an outbound call.
   *
   * Arrives after the agent has already started talking, because detection runs in
   * parallel rather than in front of the call — synchronous detection cost every human
   * caller nearly seven seconds of silence. So this is a late correction, not a gate.
   *
   * Signature-verified like any other carrier webhook: it is a public URL that can hang
   * up calls, which is a denial of service if anyone can post to it.
   */
  @Post("amd")
  @HttpCode(HttpStatus.OK)
  async answeringMachine(
    @Body() body: unknown,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): Promise<void> {
    const verified = this.telephony.verifyWebhook({
      url: `${this.config.publicBaseUrl}${AMD_WEBHOOK_PATH}`,
      params: body,
      signature: signature ?? null,
    });
    if (!verified) {
      this.log.warn("rejected unsigned answering-machine webhook");
      throw new ForbiddenException();
    }

    const fields = (body ?? {}) as Record<string, unknown>;
    const callSid = typeof fields["CallSid"] === "string" ? fields["CallSid"] : null;
    const answeredBy = typeof fields["AnsweredBy"] === "string" ? fields["AnsweredBy"] : "unknown";
    if (callSid === null) return;

    // Branded once here, at the edge, so nothing downstream handles an unvalidated
    // carrier string.
    const callId = asCallId(callSid);
    const log = this.log.child({ callId });
    log.info("carrier reported what answered", { answeredBy });

    /**
     * Written down, not merely logged, and it is the whole reason migration 0045 exists.
     *
     * Two numbers the brief asks for depend on this and neither was answerable: the
     * human-answer rate, because nothing recorded what answered, and the AMD false-positive
     * rate, which matters here more than most places — the model is trained on US carrier
     * patterns and nobody knows how it behaves on Nigerian networks. Reviewing a call and
     * seeing "the carrier said machine" beside a transcript of a person talking is how that
     * gets found.
     *
     * Not awaited and swallowed on failure: this webhook must return 200 quickly, and a
     * missing measurement is not a reason to make the carrier retry.
     */
    if (this.dataSource !== null) {
      void recordCallEventByCarrierId(this.dataSource, callSid, "answered_by", {
        answeredBy,
      }).catch((error: unknown) => {
        log.warn("could not record what answered", {
          answeredBy,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // "human" and "unknown" both keep the call. Hanging up on an uncertain verdict would
    // drop real callers, and the cost of talking to a voicemail is money rather than a
    // lost customer — so the doubt resolves in the caller's favour.
    if (!answeredBy.startsWith("machine") && answeredBy !== "fax") return;

    /**
     * Leave one short message, then hang up — and never converse.
     *
     * Hanging up silently was the earlier behaviour and I defended it as the safer option.
     * It is not: the person finds a missed call from an unknown number and learns nothing,
     * which serves neither them nor the business, and ten words that say who rang and how
     * to call back carry no risk at all.
     *
     * The message was composed when the call started, where the organisation is known, and
     * carries only those two things. Nothing about why we rang goes on an answerphone: it
     * is played out loud in a room, and whoever is in that room did not agree to hear
     * somebody else's business.
     *
     * No message means hang up, which is exactly what happened before. A message that
     * cannot say who rang is worse than the silence it would replace.
     */
    const message = this.media.voicemailFor(callSid);
    try {
      if (message === null) {
        await this.telephony.endCall(callId);
        log.info("hung up on a voicemail, having nothing safe to say", { answeredBy });
        return;
      }
      await this.telephony.leaveVoicemail(callId, message);
      log.info("left a message on a voicemail", { answeredBy });
    } catch (error) {
      log.error("could not deal with a voicemail", {
        answeredBy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Where a call got to.
   *
   * Inbound is answered by definition, so this exists for outbound: busy, no-answer,
   * failed and canceled all happen with no media stream, and without them a call that
   * rang out is indistinguishable from one that was never placed. Until today that was
   * literally true — we placed calls and could not tell whether they connected.
   *
   * Signature-verified like every other carrier webhook. It is a public URL and the
   * events it carries will drive retry decisions, so an unauthenticated one lets anyone
   * tell us a call failed that did not.
   */
  @Post("status")
  @HttpCode(HttpStatus.OK)
  callStatus(
    @Body() body: unknown,
    @Headers("x-twilio-signature") signature: string | undefined,
  ): void {
    const verified = this.telephony.verifyWebhook({
      url: `${this.config.publicBaseUrl}${STATUS_WEBHOOK_PATH}`,
      params: body,
      signature: signature ?? null,
    });
    if (!verified) {
      this.log.warn("rejected unsigned call status webhook");
      throw new ForbiddenException();
    }

    const event = this.telephony.parseCallStatus(body);
    if (event === null) {
      // A carrier that adds a status must not take the process down, but it must not be
      // silent either — an unrecognised terminal state would look like a call still ringing.
      this.log.warn("unrecognised call status callback");
      return;
    }

    const log = this.log.child({ callId: event.callId });
    const terminal = ["completed", "busy", "no-answer", "failed", "canceled"].includes(event.status);

    // Deliberately logged at warn when an outbound call never reached anyone: this is the
    // signal a campaign would retry on, and info would bury it among the ringing events.
    const missed = terminal && event.direction === "outbound" && !wasAnswered(event);
    const line = { status: event.status, direction: event.direction,
      durationSeconds: event.durationSeconds, sipCode: event.sipCode };

    if (missed) log.warn("outbound call reached nobody", line);
    else log.info("call status", line);

    // Stored, not just logged. The callback was firing correctly and carrier_status stayed
    // null on every call, because logging it is not recording it.
    if (terminal && this.dataSource !== null) {
      void closeCallByCarrierId(
        this.dataSource,
        event.callId,
        event.status,
        event.durationSeconds,
      ).catch((error: unknown) => {
        log.error("could not store the carrier's call status", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    // Slice 2's event log is where these belong once it is wired; R7.5 wants the whole
    // lifecycle recoverable per organization, not just the part that produced audio.
  }
}
