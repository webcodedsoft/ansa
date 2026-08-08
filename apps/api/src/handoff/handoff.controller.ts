import type { Logger } from "@ansa/shared";
import type { TelephonyProvider } from "@ansa/telephony";
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from "@nestjs/common";

import { LOGGER, TELEPHONY_PROVIDER } from "../telephony/tokens";
import { WHISPER_REGISTRY } from "./tokens";
import type { WhisperRegistry } from "./whisper";

/** Structural view of the platform response, so no HTTP vendor type appears here. */
interface HttpResponse {
  setHeader(name: string, value: string): void;
}

/**
 * The summary, spoken to the person answering a transfer.
 *
 * The carrier fetches this the moment they pick up and plays it to them alone, before the
 * two legs are joined. It is the difference between a transfer and a handoff: without it
 * the person says "hello?" to a caller who has already explained everything once.
 *
 * **Authorisation is the token in the path and nothing else.** It is 128 bits from the
 * CSPRNG, single use, and expires in a minute — see whisper.ts. Carrier signature
 * verification would add proof of origin on top, and is worth adding once the whisper is
 * proved on a real call; it is not here yet because a mismatch between the signed URL and
 * the configured base URL fails closed, and it would fail closed on the one call where a
 * caller has already been failed twice.
 */
@Controller("handoff")
export class HandoffController {
  constructor(
    @Inject(TELEPHONY_PROVIDER) private readonly telephony: TelephonyProvider,
    @Inject(WHISPER_REGISTRY) private readonly whisper: WhisperRegistry,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  private render(token: string, res: HttpResponse): string {
    const line = this.whisper.take(token);
    if (line === null) {
      // Indistinguishable from a token that never existed. A different answer for
      // "expired" would confirm to a prober that a transfer had happened.
      this.log.warn("whisper requested with an unknown or spent token");
      throw new NotFoundException();
    }

    const response = this.telephony.renderWhisper(line);
    res.setHeader("Content-Type", response.contentType);
    // The summary is the most concentrated personal data the product produces: who is
    // calling, what they confirmed, what was done for them.
    res.setHeader("Cache-Control", "no-store");
    this.log.info("briefed the person answering", { chars: line.length });
    return response.body;
  }

  /** The carrier POSTs by default. */
  @Post("whisper/:token")
  @HttpCode(HttpStatus.OK)
  spoken(@Param("token") token: string, @Res({ passthrough: true }) res: HttpResponse): string {
    return this.render(token, res);
  }

  /** And GETs when the account is configured for it. Same single use either way. */
  @Get("whisper/:token")
  spokenViaGet(
    @Param("token") token: string,
    @Res({ passthrough: true }) res: HttpResponse,
  ): string {
    return this.render(token, res);
  }
}
