import { purgeExpiredCallContent, type Db, type PurgedCallContent } from "@ansa/db";
import type { Logger } from "@ansa/shared";
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";

import { DATA_SOURCE, LOGGER } from "../telephony/tokens";

/**
 * Enforcing `organizations.transcript_retention_days` — the other half of a retention policy
 * that only ever covered audio.
 *
 * `AudioRetentionSweeper` deletes the recording of somebody reading their policy number
 * aloud. Nothing deleted the transcript of them reading it, and since R5.2.4 was withdrawn
 * nothing masks it either: the event log carries a NIN, a BVN and a one-time code in full.
 * Deliberately — a shape-based masker that misses names in prose is worse than none — but the
 * consequence was that the words became the longest-lived copy of the most sensitive thing on
 * the call, kept forever because nobody had chosen a number.
 *
 * A separate sweeper rather than a branch inside the audio one, and the reason is the failure
 * mode rather than tidiness. That sweeper does most of its work only when `RECORD_AUDIO_DIR`
 * is set, because with no directory there are no files. The words are written whether or not
 * audio recording is on — so a rule that lived beside the file walk would silently not run on
 * exactly the deployments that thought they had turned recording off.
 */

/** Four times a day, matching audio. Retention is in days; the hour is not interesting. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class CallContentRetentionSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap(): void {
    /* No database is not a quiet skip here the way it is for audio. Without one there is
       nothing storing the words either, so there is genuinely nothing to enforce — but the
       audio sweeper warns in the same position and the asymmetry would read as an oversight
       rather than a difference. It is a difference: no database, no transcripts. */
    if (this.dataSource === null) return;

    void this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_EVERY_MS);
    // Never a reason to hold the process open for a retention timer.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Returns what it removed so a test can assert on the numbers rather than on a
   * log line.
   *
   * A failure must never take the process down. This runs beside live calls, and a database
   * hiccup at four in the morning is not worth a restart — it is logged, and the next pass
   * six hours later deletes whatever this one did not.
   */
  async sweep(): Promise<PurgedCallContent> {
    const nothing: PurgedCallContent = { transcripts: 0, events: 0, invocations: 0 };
    const db = this.dataSource;
    if (db === null) return nothing;

    try {
      const purged = await purgeExpiredCallContent(db);
      const total = purged.transcripts + purged.events + purged.invocations;
      if (total > 0) {
        /* Counts only, and that is not incidental: what was in those rows is precisely what
           this exists to stop being kept, so logging a sample would put it straight back
           into a file with its own retention problem. */
        this.log.info("deleted call content past its organization's retention", {
          transcripts: purged.transcripts,
          events: purged.events,
          invocations: purged.invocations,
        });
      }
      return purged;
    } catch (error) {
      this.log.error("call content retention sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return nothing;
    }
  }
}
