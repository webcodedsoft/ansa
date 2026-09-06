import {
  readCallsNeedingSummary,
  readSummarisableLines,
  saveCallSummary,
  withOrganization,
  type Db,
  type SummarisableLine,
} from "@ansa/db";
import type { Logger } from "@ansa/shared";
import type { LlmProvider } from "@ansa/llm";
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";

import { DATA_SOURCE, LLM_PROVIDER, LOGGER } from "../telephony/tokens";
import { buildSummaryPrompt, parseSummary, PROMPT_VERSION, type Summary } from "./summarise";

/**
 * Writes what each finished call came to.
 *
 * **The first model call in this codebase that is not on the live path**, and it is a sweeper
 * rather than a step at hang-up for two reasons. A round trip at hang-up would put a model on
 * the call path, which is the one place this product refuses to put anything it can avoid. And
 * transcripts are flushed in batches, so a summary written the instant a call ended would
 * describe whatever had landed — missing the last exchange, usually the one that says how it
 * turned out. Waiting a minute costs nothing; nobody is watching for it.
 *
 * Retryable by construction: a call with no summary row is found again next pass, so a model
 * outage delays summaries rather than losing them.
 */

/** Often enough to feel immediate on a quiet line, rarely enough to batch on a busy one. */
const SWEEP_EVERY_MS = 60_000;

/** Long enough for the recorder's five-second flush and its retries to have settled. */
const SETTLE_SECONDS = 90;

/** Per pass. A backlog drains over several minutes rather than in one burst of model calls. */
const BATCH = 5;

/** A model that has not answered by now has failed, and the fallback beats waiting. */
const MODEL_TIMEOUT_MS = 20_000;

/**
 * What a call came to, without a model.
 *
 * Not a placeholder. It is what the handoff summary has always done — the caller's first real
 * sentence is what they rang about — and it is the honest thing to show when the model is
 * unavailable: a blank card tells a reader nothing, and waiting for a model that is down means
 * the summary arrives days later beside a call nobody is looking at any more.
 *
 * Stored with `model: null`, which is how a reader and a re-run both tell the two apart.
 */
export const withoutAModel = (lines: readonly SummarisableLine[]): Summary => {
  const first = lines.find(
    (line) => line.speaker === "caller" && line.text.trim().split(/\s+/).length >= 3,
  );
  const last = [...lines].reverse().find((line) => line.speaker === "caller");
  if (first === undefined) return { summary: "", cites: [] };

  const sentences: string[] = [`They rang about: ${first.text.trim()}`];
  const cites: string[][] = [[first.id]];

  if (last !== undefined && last.id !== first.id) {
    sentences.push(`The last thing they said was: ${last.text.trim()}`);
    cites.push([last.id]);
  }
  return { summary: sentences.join(" "), cites };
};

@Injectable()
export class CallSummarySweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  onApplicationBootstrap(): void {
    if (this.dataSource === null) return; // no database, no calls to summarise
    this.timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Returns how many it wrote, so a test asserts on the number and not a log line. */
  async sweep(): Promise<number> {
    const db = this.dataSource;
    if (db === null || this.running) return 0;
    this.running = true;

    try {
      const due = await readCallsNeedingSummary(db, SETTLE_SECONDS, BATCH);
      let count = 0;

      for (const call of due) {
        try {
          const saved = await withOrganization(db, call.organizationId, async (scope) => {
            const lines = await readSummarisableLines(scope, call.callId);
            if (lines.length === 0) return false;

            const asked = await this.ask(lines);
            /* Nothing from the model, or nothing that survived grounding. The reducer's
               account is thin but true, and every sentence of it is a line of the call. */
            const written =
              asked.summary === "" ? { ...withoutAModel(lines), model: null } : asked;
            if (written.summary === "") return false;

            return saveCallSummary(scope, call.callId, {
              summary: written.summary,
              cites: written.cites,
              model: written.model,
              promptVersion: PROMPT_VERSION,
            });
          });
          if (saved) count += 1;
        } catch (error) {
          /* One call failing must not stop the pass. It has no summary row, so the next sweep
             finds it again — which is the whole reason this is a sweeper. */
          this.log.warn("could not summarise a call", {
            // `callRowId`, not `callId`: the logger's typed field is the carrier's id and
            // this is ours. The distinction is the same one `recordTranscripts` draws.
            callRowId: call.callId,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (count > 0) this.log.info("summarised finished calls", { written: count });
      return count;
    } catch (error) {
      this.log.warn("call summary sweep failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Ask the model, and take only what it can point at.
   *
   * The stream is collected rather than forwarded: nobody is listening, so there is no reason
   * to stream, and `parseSummary` needs a whole reply to find the JSON in. The timeout lives
   * here rather than in the provider because this is the only caller that can afford to give
   * up — a live turn cannot.
   */
  private async ask(
    lines: readonly SummarisableLine[],
  ): Promise<Summary & { readonly model: string | null }> {
    const prompt = buildSummaryPrompt(lines);

    const reply = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve(""), MODEL_TIMEOUT_MS);
      const done = (text: string): void => {
        clearTimeout(timer);
        resolve(text);
      };

      try {
        const stream = this.llm.complete({
          system:
            "You summarise finished phone calls for the people who run the business. You are accurate and brief, and you never state anything the transcript does not show.",
          messages: [{ role: "user", content: prompt }],
          maxTokens: 400,
        });
        stream.onDone(done);
      } catch {
        done("");
      }
    });

    if (reply === "") return { summary: "", cites: [], model: null };
    return { ...parseSummary(reply, lines), model: this.llm.name };
  }
}
