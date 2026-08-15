import { timingSafeEqual } from "node:crypto";

import {
  exportCorpus,
  listCalls,
  listEventDeliveries,
  loadCall,
  loadCallRecords,
  loadCurrentAgentConfig,
  readClaimSource,
  recordTranscriptCorrection,
  withOrganization,
  type Db,
} from "@ansa/db";
import { asOrganizationId, type Logger } from "@ansa/shared";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import type { AppConfig } from "../config/env";
import { APP_CONFIG, DATA_SOURCE, LOGGER } from "../telephony/tokens";
import { BASE_KEYTERMS } from "../tenancy/defaults";
import { alertsFor } from "./alerts";
import { renderClaim } from "./claims";
import { priceUsage, readCostRates, usageOverCalls } from "./cost";
import { scoreCalls } from "./metrics";
import {
  renderCall,
  renderCallList,
  renderCorpus,
  renderCorpusJsonl,
  renderDeliveries,
  renderMetrics,
  renderReviewQueue,
  renderSuggestions,
} from "./render";
import { reviewQueue } from "./review";
import { captureCases, keytermCandidates } from "./suggestions";
import { trendByConfigVersion } from "./trends";

/** How many recent calls a score is computed over. Enough to see a change, cheap to read. */
const METRIC_WINDOW = 200;

/**
 * The internal call viewer (R8.1) and the review loop it exists to serve (R9.2).
 *
 * Debugging tool, not a product surface. It is behind the same public tunnel the carrier
 * uses, and what it shows is transcripts — the one place in the system where callers say
 * their policy numbers out loud. So it needs a token, and it needs the organization named
 * explicitly rather than inferred, because there is no session here to infer one from.
 *
 * Route order is load-bearing: Nest matches in declaration order, so `metrics` and
 * `corpus.jsonl` must be declared before `:id` or they are read as call ids.
 */
@Controller("viewer")
export class ViewerController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATA_SOURCE) private readonly dataSource: Db | null,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /**
   * Constant-time, and closed when unconfigured.
   *
   * An unset token meaning "no auth" is how an internal tool ends up open on the
   * internet, so it means "no viewer" instead.
   */
  private authorise(token: string | undefined): void {
    const expected = this.config.viewerToken;
    if (expected === undefined || expected.length === 0) {
      this.log.warn("viewer is disabled: VIEWER_TOKEN is not set");
      throw new NotFoundException();
    }
    const given = Buffer.from(token ?? "");
    const want = Buffer.from(expected);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      this.log.warn("rejected an unauthorised viewer request");
      throw new ForbiddenException();
    }
  }

  private scope(organization: string | undefined): { db: Db; organizationId: ReturnType<typeof asOrganizationId> } {
    if (this.dataSource === null) throw new NotFoundException();
    if (organization === undefined) throw new ForbiddenException();
    // asOrganizationId rejects a malformed value here rather than letting it reach the RLS cast.
    return { db: this.dataSource, organizationId: asOrganizationId(organization) };
  }

  /** Form fields arrive as `unknown`; nothing is read off a body without checking it first. */
  private field(body: unknown, name: string): string | undefined {
    if (typeof body !== "object" || body === null) return undefined;
    const value = (body as Record<string, unknown>)[name];
    return typeof value === "string" ? value : undefined;
  }

  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async index(@Query("token") token?: string, @Query("organization") organization?: string): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    return renderCallList(await listCalls(db, organizationId), { token: token ?? "", organization: organization ?? "" });
  }

  @Get("metrics")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async metrics(@Query("token") token?: string, @Query("organization") organization?: string): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    const records = await loadCallRecords(db, organizationId, METRIC_WINDOW);
    // One pass over one set of records, feeding all three. Quality, what is outside its
    // threshold, and what the window cost are three readings of the same event log, and
    // computing any of them from a different source is how two of them start disagreeing.
    const metrics = scoreCalls(records);
    return renderMetrics(
      metrics,
      { token: token ?? "", organization: organization ?? "" },
      { calls: records.length },
      alertsFor(metrics),
      priceUsage(usageOverCalls(records), readCostRates(process.env)),
      trendByConfigVersion(records),
    );
  }

  /**
   * The review queue (R9.2.1, R9.2.2).
   *
   * Same window, same `loadCallRecords`, same event log as the metrics page — the queue is
   * a different reading of the calls the scoreboard already counted, not a second scan.
   * Declared before `:id`, like everything else here, or it is read as a call id.
   */
  @Get("review")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async review(@Query("token") token?: string, @Query("organization") organization?: string): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    const records = await loadCallRecords(db, organizationId, METRIC_WINDOW);
    return renderReviewQueue(reviewQueue(records), { token: token ?? "", organization: organization ?? "" }, {
      calls: records.length,
    });
  }

  /**
   * What the corrections are evidence for, and what nobody has approved (R9.2.5).
   *
   * The organization's current keyterms are read only to subtract them: a candidate they already
   * carry is not a suggestion. Falls back to the platform base alone when the organization has no
   * configuration row, which under-filters rather than over-filters — a duplicate suggestion
   * wastes a reader's second, a missing one loses the finding.
   */
  @Get("suggestions")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async suggestions(
    @Query("token") token?: string,
    @Query("organization") organization?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    const entries = await exportCorpus(db, organizationId);
    const current = await withOrganization(db, organizationId, loadCurrentAgentConfig);
    const known = [...BASE_KEYTERMS, ...(current?.config.keyterms ?? [])];
    return renderSuggestions(
      keytermCandidates(entries, { known }),
      captureCases(entries),
      { token: token ?? "", organization: organization ?? "" },
      known,
    );
  }

  /**
   * What we pushed to this organization's own systems, and what happened to it (Slice 6a).
   *
   * Declared before `:id` for the same reason `metrics` is: Nest matches in declaration
   * order and `deliveries` would otherwise be read as a call id.
   */
  @Get("deliveries")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async deliveries(
    @Query("token") token?: string,
    @Query("organization") organization?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    return renderDeliveries(await listEventDeliveries(db, organizationId), {
      token: token ?? "",
      organization: organization ?? "",
    });
  }

  @Get("corpus")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async corpus(@Query("token") token?: string, @Query("organization") organization?: string): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    return renderCorpus(await exportCorpus(db, organizationId), {
      token: token ?? "",
      organization: organization ?? "",
    });
  }

  /**
   * The corpus as a file (R9.2.4).
   *
   * Downloadable rather than rendered, because the consumer is the eval harness. It is
   * caller speech, so it is served no-store and never cached anywhere on the way.
   */
  @Get("corpus.jsonl")
  @Header("Content-Type", "application/x-ndjson; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async corpusFile(
    @Query("token") token?: string,
    @Query("organization") organization?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    return renderCorpusJsonl(await exportCorpus(db, organizationId));
  }

  /**
   * One call's reviewed turns as an `eval/` claim file (R9.2.4).
   *
   * Declared before `:id`. Nest matches in declaration order and a two-segment path cannot
   * collide with a one-segment one, but the ordering rule on this controller is worth
   * keeping unconditional rather than reasoned about per route.
   *
   * Served as a download because the consumer is `python3 eval/verdict.py` and the workflow
   * is: save it into `eval/claims/`, run a candidate over the audio three times, score. It
   * carries a caller's words, so it is no-store like everything else here.
   */
  @Get(":id/claim.json")
  @Header("Content-Type", "application/json; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async claim(
    @Param("id") id: string,
    @Query("token") token?: string,
    @Query("organization") organization?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    const source = await readClaimSource(db, organizationId, id);
    // Not theirs and not there are one answer, as on every other read here.
    if (source === null) throw new NotFoundException();
    return renderClaim(source);
  }

  @Get(":id")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async call(
    @Param("id") id: string,
    @Query("token") token?: string,
    @Query("organization") organization?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);
    const detail = await loadCall(db, organizationId, id);
    // Indistinguishable from another organization's call, on purpose: a viewer that told you a
    // call existed but was not yours would leak exactly what RLS is there to hide.
    if (detail === null) throw new NotFoundException();
    return renderCall(detail, { token: token ?? "", organization: organization ?? "" });
  }

  /**
   * Records a reviewer's verdict on one transcript (R9.2.3).
   *
   * POST, because it writes. The credentials travel in the body rather than the query
   * string so a correction does not put the token in the address bar; the token is
   * checked exactly as it is on every read.
   *
   * The corrected text is never logged. It is the same sentence the caller spoke, which
   * is the one class of content this system tries hardest not to scatter — the whole
   * reason the viewer is token-gated in the first place.
   */
  @Post(":id/corrections")
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async correct(@Param("id") id: string, @Body() body: unknown): Promise<string> {
    const token = this.field(body, "token");
    const organization = this.field(body, "organization");
    this.authorise(token);
    const { db, organizationId } = this.scope(organization);

    const transcriptId = this.field(body, "transcriptId");
    const correctedText = this.field(body, "correctedText");
    if (transcriptId === undefined || correctedText === undefined) {
      throw new BadRequestException();
    }

    const applied = await recordTranscriptCorrection(db, organizationId, {
      transcriptId,
      correctedText,
    });
    // Not theirs, or not there. The same answer either way, for the same reason the call
    // page 404s rather than 403s.
    if (!applied) throw new NotFoundException();
    // The row ids and nothing else. What the reviewer typed is the sentence the caller
    // spoke, and a log line is the last place it should end up.
    this.log.info("transcript corrected", { callRowId: id, transcriptId });

    const detail = await loadCall(db, organizationId, id);
    if (detail === null) throw new NotFoundException();
    return renderCall(detail, { token: token ?? "", organization: organization ?? "" });
  }
}
