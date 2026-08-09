import { listCallPage } from "@ansa/db";
import { Controller, Get, Inject } from "@nestjs/common";

import { Endpoint } from "../http/endpoint";
import { pageQuery, pageResponse, toPageBody, toPageRequest } from "../http/pagination";
import { apiRoute, FromQuery } from "../http/request";
import { integer, nullable, object, text, type Infer } from "../http/schema";
import { timestamp, uuid } from "../schemas";
import { TenantContext } from "../tenancy/tenant-context";

/**
 * The organisation's own call history.
 *
 * **This is the other file to copy from**, and the one closest to what the next four
 * agents are building: a capability-gated, paginated read of a table the call path writes
 * and the dashboard only reads.
 *
 * Worth noticing what is not here. `calls` predates this whole layer, is written by the
 * media gateway, and has `tenant_id` on every row — and this handler still contains no
 * tenant id, no `where tenant_id = …`, and no way to supply one. The scope is the tenant.
 * An endpoint over any other existing table looks exactly like this.
 */

const call = object({
  id: uuid(),
  direction: text({ maxLength: 16 }),
  dialled: text({ maxLength: 32 }),
  caller: nullable(text({ maxLength: 32 })),
  answeredAt: nullable(timestamp()),
  endedAt: nullable(timestamp()),
  endReason: nullable(text({ maxLength: 64 })),
  durationSeconds: nullable(integer({ minimum: 0 })),
  createdAt: timestamp(),
});

const callPage = pageResponse(call);

@Controller(apiRoute("calls"))
export class CallsController {
  constructor(@Inject(TenantContext) private readonly db: TenantContext) {}

  @Get()
  @Endpoint({
    summary: "List this organisation's calls, newest first",
    capability: "calls:read",
    query: pageQuery,
    response: callPage,
  })
  async list(@FromQuery() query: Infer<typeof pageQuery>): Promise<Infer<typeof callPage>> {
    const page = toPageRequest(query);
    return toPageBody(await this.db.tx((scope) => listCallPage(scope, page)));
  }
}
