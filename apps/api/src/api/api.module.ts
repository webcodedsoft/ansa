import { createDataSource, type Db } from "@ansa/db";
import { createLogger, type Logger } from "@ansa/shared";
import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { ApiGuard } from "./auth/api.guard";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { CallsController } from "./calls/calls.controller";
import { loadApiConfig } from "./config";
import { EndpointInterceptor } from "./http/endpoint.interceptor";
import { ProblemFilter } from "./http/problem";
import { RateLimitGuard } from "./http/rate-limit.guard";
import { RequestIdMiddleware } from "./http/request-id.middleware";
import { InvitationsController } from "./invitations/invitations.controller";
import { MembersController } from "./members/members.controller";
import { TenantContext } from "./tenancy/tenant-context";
import { TenantGateway } from "./tenancy/tenant-gateway";
import { API_DATA_SOURCE } from "./tenancy/tokens";

/**
 * The tenant-facing dashboard API.
 *
 * One list of controllers, used three times: to register them, to attach the middleware,
 * and — in `routes.test.ts` — to check every route they declare is under the prefix and
 * carries an `@Endpoint`. A new controller added here is guarded, validated and audited by
 * the same act of adding it; one added anywhere else fails the test.
 */
export const API_CONTROLLERS = [
  AuthController,
  CallsController,
  InvitationsController,
  MembersController,
];

@Module({
  controllers: API_CONTROLLERS,
  providers: [
    {
      provide: API_DATA_SOURCE,
      // Its own pool. See tenancy/tokens.ts for why it is not the call path's.
      useFactory: async (): Promise<Db | null> => {
        const config = loadApiConfig();
        const log: Logger = createLogger({ component: "api" });
        if (config.databaseUrl === undefined) {
          log.warn("no DATABASE_URL: the dashboard API will answer 503");
          return null;
        }
        try {
          const dataSource = await createDataSource({
            url: config.databaseUrl,
            poolSize: config.poolSize,
          }).initialize();
          await dataSource.query("select 1");
          return dataSource;
        } catch (error) {
          // Boot rather than refuse to start: this process also answers calls, and a
          // dashboard that cannot reach the database must not take the phone line with it.
          log.error("dashboard database unavailable at boot", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },
    },
    TenantGateway,
    TenantContext,
    AuthService,

    // Order matters, and only for the guards. The rate limiter runs first so that the
    // endpoints it protects are throttled before they spend a hundred milliseconds of
    // scrypt; ApiGuard then authenticates and authorises.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ApiGuard },
    { provide: APP_INTERCEPTOR, useClass: EndpointInterceptor },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
})
export class ApiModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // By controller rather than by path pattern: the same list, so a new controller cannot
    // be registered and left out, and no route-matching syntax to get wrong.
    consumer.apply(RequestIdMiddleware).forRoutes(...API_CONTROLLERS);
  }
}
