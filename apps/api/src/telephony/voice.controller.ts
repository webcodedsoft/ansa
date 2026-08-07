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
import type { Logger } from "@ansa/shared";
import type { TelephonyProvider } from "@ansa/telephony";

import type { AppConfig } from "../config/env";
import { APP_CONFIG, LOGGER, MEDIA_STREAM_PATH, TELEPHONY_PROVIDER, VOICE_WEBHOOK_PATH } from "./tokens";

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
  ) {}

  @Post("voice")
  // Nest answers POST with 201 by default. The carrier expects 200 for TwiML and
  // treats anything else as a failed webhook, which drops the call.
  @HttpCode(HttpStatus.OK)
  answer(
    @Body() body: unknown,
    @Headers("x-twilio-signature") signature: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ): string {
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

    const wsOrigin = this.config.publicBaseUrl.replace(/^http/, "ws");
    const answer = this.telephony.renderAnswer({
      mediaStreamUrl: `${wsOrigin}${MEDIA_STREAM_PATH}`,
    });

    res.setHeader("Content-Type", answer.contentType);
    return answer.body;
  }
}
