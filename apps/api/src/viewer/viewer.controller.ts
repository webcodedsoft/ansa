import { timingSafeEqual } from "node:crypto";

import {
  exportCorpus,
  listCalls,
  loadCall,
  loadCallRecords,
  recordTranscriptCorrection,
  type Db,
} from "@ansa/db";
import { asTenantId, type Logger } from "@ansa/shared";
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
import { scoreCalls } from "./metrics";
import {
  renderCall,
  renderCallList,
  renderCorpus,
  renderCorpusJsonl,
  renderMetrics,
} from "./render";

/** How many recent calls a score is computed over. Enough to see a change, cheap to read. */
const METRIC_WINDOW = 200;

/**
 * The internal call viewer (R8.1) and the review loop it exists to serve (R9.2).
 *
 * Debugging tool, not a product surface. It is behind the same public tunnel the carrier
 * uses, and what it shows is transcripts — the one place in the system where callers say
 * their policy numbers out loud. So it needs a token, and it needs the tenant named
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

  private scope(tenant: string | undefined): { db: Db; tenantId: ReturnType<typeof asTenantId> } {
    if (this.dataSource === null) throw new NotFoundException();
    if (tenant === undefined) throw new ForbiddenException();
    // asTenantId rejects a malformed value here rather than letting it reach the RLS cast.
    return { db: this.dataSource, tenantId: asTenantId(tenant) };
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
  async index(@Query("token") token?: string, @Query("tenant") tenant?: string): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    return renderCallList(await listCalls(db, tenantId), { token: token ?? "", tenant: tenant ?? "" });
  }

  @Get("metrics")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async metrics(@Query("token") token?: string, @Query("tenant") tenant?: string): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    const records = await loadCallRecords(db, tenantId, METRIC_WINDOW);
    return renderMetrics(
      scoreCalls(records),
      { token: token ?? "", tenant: tenant ?? "" },
      { calls: records.length },
    );
  }

  @Get("corpus")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async corpus(@Query("token") token?: string, @Query("tenant") tenant?: string): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    return renderCorpus(await exportCorpus(db, tenantId), {
      token: token ?? "",
      tenant: tenant ?? "",
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
    @Query("tenant") tenant?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    return renderCorpusJsonl(await exportCorpus(db, tenantId));
  }

  @Get(":id")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  @Header("Referrer-Policy", "no-referrer")
  async call(
    @Param("id") id: string,
    @Query("token") token?: string,
    @Query("tenant") tenant?: string,
  ): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    const detail = await loadCall(db, tenantId, id);
    // Indistinguishable from another tenant's call, on purpose: a viewer that told you a
    // call existed but was not yours would leak exactly what RLS is there to hide.
    if (detail === null) throw new NotFoundException();
    return renderCall(detail, { token: token ?? "", tenant: tenant ?? "" });
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
    const tenant = this.field(body, "tenant");
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);

    const transcriptId = this.field(body, "transcriptId");
    const correctedText = this.field(body, "correctedText");
    if (transcriptId === undefined || correctedText === undefined) {
      throw new BadRequestException();
    }

    const applied = await recordTranscriptCorrection(db, tenantId, {
      transcriptId,
      correctedText,
    });
    // Not theirs, or not there. The same answer either way, for the same reason the call
    // page 404s rather than 403s.
    if (!applied) throw new NotFoundException();
    // The row ids and nothing else. What the reviewer typed is the sentence the caller
    // spoke, and a log line is the last place it should end up.
    this.log.info("transcript corrected", { callRowId: id, transcriptId });

    const detail = await loadCall(db, tenantId, id);
    if (detail === null) throw new NotFoundException();
    return renderCall(detail, { token: token ?? "", tenant: tenant ?? "" });
  }
}
