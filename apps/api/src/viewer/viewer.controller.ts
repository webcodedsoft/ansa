import { timingSafeEqual } from "node:crypto";

import { listCalls, loadCall, type Db } from "@ansa/db";
import { asTenantId, type Logger } from "@ansa/shared";
import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
} from "@nestjs/common";

import type { AppConfig } from "../config/env";
import { APP_CONFIG, DATA_SOURCE, LOGGER } from "../telephony/tokens";
import { renderCall, renderCallList } from "./render";

/**
 * The internal call viewer (R8.1).
 *
 * Debugging tool, not a product surface. It is behind the same public tunnel the carrier
 * uses, and what it shows is transcripts — the one place in the system where callers say
 * their policy numbers out loud. So it needs a token, and it needs the tenant named
 * explicitly rather than inferred, because there is no session here to infer one from.
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

  @Get()
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async index(@Query("token") token?: string, @Query("tenant") tenant?: string): Promise<string> {
    this.authorise(token);
    const { db, tenantId } = this.scope(tenant);
    return renderCallList(await listCalls(db, tenantId));
  }

  @Get(":id")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Cache-Control", "no-store")
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
    return renderCall(detail);
  }
}
