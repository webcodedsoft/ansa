import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  expiredCallAudio,
  knownCallIds,
  minAudioRetentionDays,
  purgeExpiredAudioSegments,
  type Db,
} from "@ansa/db";
import type { Logger } from "@ansa/shared";
import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";

import type { AppConfig } from "../config/env";
import { APP_CONFIG, DATA_SOURCE, LOGGER } from "../telephony/tokens";

/**
 * Enforcing `organizations.audio_retention_days`.
 *
 * The column has existed since schema v1 and nothing has ever honoured it, while
 * RECORD_AUDIO_DIR writes the caller's raw voice to disk — a person reading their policy
 * number aloud, kept forever by default. A retention setting nothing enforces is worse
 * than no setting: it reads as a policy in review and is a lie on the filesystem.
 *
 * Three rules, and the third is the one that is easy to get wrong:
 *
 *   expired      the call is older than its own organization's window. Delete it.
 *   within       the call is younger. Keep it, however long that organization chose.
 *   unattributed no call row names this recording — written before the organization resolved,
 *                or the row never landed. Nobody's policy covers it, so the strictest
 *                one does. It is still somebody's voice.
 */

/** One file in the recording directory, as the policy sees it. */
export interface RecordingOnDisk {
  readonly file: string;
  /** The carrier's call id, which is what a recording is named after. */
  readonly callId: string;
  readonly modifiedAt: Date;
}

export interface RetentionVerdicts {
  readonly expired: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
}

/**
 * The whole policy, as a pure function, so it can be tested without a disk or a database.
 *
 * Deleting a caller's voice is not something to discover the behaviour of in production.
 */
export const recordingsToDelete = (
  recordings: readonly RecordingOnDisk[],
  verdicts: RetentionVerdicts,
  orphanCutoff: Date,
): readonly RecordingOnDisk[] =>
  recordings.filter(
    (r) =>
      verdicts.expired.has(r.callId) ||
      (!verdicts.known.has(r.callId) && r.modifiedAt.getTime() < orphanCutoff.getTime()),
  );

/** `CA1234.ulaw` is the recording of call `CA1234`. Anything else is not ours to delete. */
const RECORDING = /^(.+)\.(?:ulaw|wav|pcm)$/;

const DAY_MS = 86_400_000;
/** Four times a day. Retention is measured in days; the exact hour is not interesting. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class AudioRetentionSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.dataSource === null) {
      // Without the database there is no policy to read, so there is nothing this can
      // honestly enforce. Say so rather than sweeping on a guess.
      if (this.config.recordAudioDir !== undefined) {
        this.log.warn("audio recording is on with no database: retention cannot be enforced", {
          dir: this.config.recordAudioDir,
        });
      }
      return;
    }

    void this.sweep();
    this.timer = setInterval(() => {
      void this.sweep();
    }, SWEEP_EVERY_MS);
    // Never a reason to hold the process open.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Returns what it removed so a test can assert on it rather than on a log
   * line, and so the numbers can be reported.
   *
   * A failure here must never take the process down: this runs beside live calls, and a
   * database hiccup at 4am is not worth a restart. It is logged and the next pass retries.
   */
  async sweep(): Promise<{ readonly recordings: number; readonly segments: number }> {
    const db = this.dataSource;
    if (db === null) return { recordings: 0, segments: 0 };

    let segments = 0;
    try {
      segments = await purgeExpiredAudioSegments(db);
      if (segments > 0) this.log.info("deleted expired audio segments", { segments });
    } catch (error) {
      this.log.error("could not purge expired audio segments", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const dir = this.config.recordAudioDir;
    if (dir === undefined) return { recordings: 0, segments };

    try {
      const recordings = await this.listRecordings(dir);
      if (recordings.length === 0) return { recordings: 0, segments };

      const [expired, known, minDays] = await Promise.all([
        expiredCallAudio(db),
        knownCallIds(db, recordings.map((r) => r.callId)),
        minAudioRetentionDays(db),
      ]);

      const doomed = recordingsToDelete(
        recordings,
        { expired: new Set(expired.map((e) => e.carrierCallId)), known },
        new Date(Date.now() - minDays * DAY_MS),
      );

      let removed = 0;
      for (const recording of doomed) {
        try {
          await unlink(join(dir, recording.file));
          removed += 1;
        } catch (error) {
          this.log.error("could not delete an expired recording", {
            // Not `callId`: the logger reserves that for a live call's branded id, and
            // this is a filename we are only guessing was one.
            recording: recording.callId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (removed > 0) {
        // Counts and call ids only. What was said in them is exactly what retention
        // exists to stop being kept.
        this.log.info("deleted recordings past their organization's retention", {
          removed,
          kept: recordings.length - removed,
          minRetentionDays: minDays,
        });
      }
      return { recordings: removed, segments };
    } catch (error) {
      this.log.error("audio retention sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { recordings: 0, segments };
    }
  }

  private async listRecordings(dir: string): Promise<readonly RecordingOnDisk[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // The directory does not exist until the first call is recorded. Not an error.
      return [];
    }

    const found: RecordingOnDisk[] = [];
    for (const name of names) {
      const match = RECORDING.exec(name);
      if (match === null) continue;
      const callId = match[1];
      if (callId === undefined) continue;
      try {
        const info = await stat(join(dir, name));
        found.push({ file: name, callId, modifiedAt: info.mtime });
      } catch {
        // Deleted underneath us, which is the outcome this is aiming at anyway.
      }
    }
    return found;
  }
}
