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
import { asCallId } from "@ansa/shared";
import type { Logger } from "@ansa/shared";
import type { TelephonyProvider } from "@ansa/telephony";

import type { AppConfig } from "../config/env";
import type { TenantRegistry } from "../tenancy/tenant-registry";
import {
  APP_CONFIG,
  LOGGER,
  AMD_WEBHOOK_PATH,
  MEDIA_STREAM_PATH,
  TELEPHONY_PROVIDER,
  TENANT_PARAM,
  TENANT_REGISTRY,
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
    @Inject(TENANT_REGISTRY) private readonly tenants: TenantRegistry,
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
    const tenant = await this.tenants.resolve(call.dialled);
    log.info("tenant resolved", {
      tenantId: tenant.tenantId,
      name: tenant.name,
      configVersion: tenant.configVersion,
      keyterms: tenant.keyterms.length,
    });

    const wsOrigin = this.config.publicBaseUrl.replace(/^http/, "ws");
    const answer = this.telephony.renderAnswer({
      mediaStreamUrl: `${wsOrigin}${MEDIA_STREAM_PATH}`,
      parameters: tenant.tenantId === null ? {} : { [TENANT_PARAM]: tenant.tenantId },
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

    // "human" and "unknown" both keep the call. Hanging up on an uncertain verdict would
    // drop real callers, and the cost of talking to a voicemail is money rather than a
    // lost customer — so the doubt resolves in the caller's favour.
    if (!answeredBy.startsWith("machine") && answeredBy !== "fax") return;

    try {
      await this.telephony.endCall(callId);
      log.info("hung up on a voicemail", { answeredBy });
    } catch (error) {
      log.error("could not hang up on a voicemail", {
        answeredBy,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
