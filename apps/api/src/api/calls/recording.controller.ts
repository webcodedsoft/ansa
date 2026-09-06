import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { mulawSeconds, wavFromLegs, type Logger } from "@ansa/shared";
import { Controller, Get, Inject, NotFoundException, Param, Res } from "@nestjs/common";

import type { ApiConfig } from "../api-config";
import type { RecordingLinks } from "./recording-links";
import { RECORDING_CONFIG, RECORDING_LINKS, RECORDING_LOGGER } from "./tokens";

/** Structural view of the platform response, so no HTTP vendor type appears here. */
interface HttpResponse {
  setHeader(name: string, value: string): void;
  send(body: Buffer): void;
}

/**
 * A call's audio, to whoever holds a live ticket for it.
 *
 * **Outside the authenticated API surface on purpose**, exactly as the handoff whisper is. An
 * `<audio>` element cannot send an authorization header, so the credential has to be in the
 * URL — and a URL that is a credential does not belong on a route where every other one is
 * authorised by a session. Who may listen was decided at `POST /calls/:callId/recording`,
 * which checked the capability, resolved the organisation and wrote the access log. This
 * spends the ticket and returns bytes.
 *
 * The ticket is 128 bits, single use, and lives two minutes. An unknown, expired or spent one
 * is a 404 indistinguishable from a call that has no recording — telling them apart would
 * confirm to a prober that a given call exists and was recorded.
 *
 * Converted on the way out rather than stored converted. The files on disk stay exactly what
 * the carrier sent, which is what the STT comparison tools replay and what makes a provider
 * problem distinguishable from an encoding one; the WAV is a view of them.
 */
@Controller("recordings")
export class RecordingController {
  constructor(
    @Inject(RECORDING_LINKS) private readonly links: RecordingLinks,
    @Inject(RECORDING_CONFIG) private readonly config: ApiConfig,
    @Inject(RECORDING_LOGGER) private readonly log: Logger,
  ) {}

  @Get(":token")
  async audio(
    @Param("token") token: string,
    @Res({ passthrough: false }) res: HttpResponse,
  ): Promise<void> {
    const dir = this.config.recordAudioDir;
    const carrierCallId = this.links.take(token);
    if (carrierCallId === null || dir === undefined) {
      this.log.warn("recording requested with an unknown or spent ticket");
      throw new NotFoundException();
    }

    /* The caller's leg is required and the agent's is not: every recording made before both
       legs were captured has only the first, and those still have to play. */
    const caller = await readFile(join(dir, `${carrierCallId}.ulaw`)).catch(() => null);
    if (caller === null) {
      this.log.warn("recording ticket named a call with no audio on disk");
      throw new NotFoundException();
    }
    const agent = await readFile(join(dir, `${carrierCallId}.agent.ulaw`)).catch(() => null);

    const wav = wavFromLegs(caller, agent);
    res.setHeader("Content-Type", "audio/wav");
    res.setHeader("Content-Length", String(wav.length));
    /* Somebody's voice. Not in a shared cache, and not in a disk cache that outlives the
       organisation's own retention window. */
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `inline; filename="${carrierCallId}.wav"`);

    this.log.info("served call audio", {
      seconds: mulawSeconds(caller.length),
      bothLegs: agent !== null,
    });
    res.send(wav);
  }
}
