import { createDataSource, type Db } from "@ansa/db";
import { createLogger, type Logger } from "@ansa/shared";
import { Module, type MiddlewareConsumer, type NestModule } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { createMailer, MAILER, type Mailer } from "../mail/mailer";
import { ApiGuard } from "./auth/api.guard";
import { AgentsController } from "./agents/agents.controller";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { CallsController } from "./calls/calls.controller";
import { loadApiConfig } from "./api-config";
import { ConfigController } from "./config/config.controller";
import { EndpointInterceptor } from "./http/endpoint.interceptor";
import { ProblemFilter } from "./http/problem";
import { OrganizationRateLimitGuard } from "./http/organization-rate-limit.guard";
import { RateLimitGuard } from "./http/rate-limit.guard";
import { RequestIdMiddleware } from "./http/request-id.middleware";
import { KnowledgeController } from "./knowledge/knowledge.controller";
import { InvitationsController } from "./invitations/invitations.controller";
import { MembersController } from "./members/members.controller";
import { NumbersController } from "./numbers/numbers.controller";
import { OrganizationController } from "./organization/organization.controller";
import { ReadinessController } from "./numbers/readiness.controller";
import { OrganizationContext } from "./tenancy/organization-context";
import { OrganizationGateway } from "./tenancy/organization-gateway";
import { API_DATA_SOURCE } from "./tenancy/tokens";
import { createOrigination, ORIGINATION } from "./testcall/origination";
import { TestCallController } from "./testcall/testcall.controller";
import { CredentialsController } from "./tools/credentials.controller";
import { EventSubscriptionsController } from "./tools/events.controller";
import { ToolsController } from "./tools/tools.controller";
import { VoicesController } from "./voices/voices.controller";

/**
 * The organization-facing dashboard API.
 *
 * One list of controllers, used three times: to register them, to attach the middleware,
 * and — in `routes.test.ts` — to check every route they declare is under the prefix and
 * carries an `@Endpoint`. A new controller added here is guarded, validated and audited by
 * the same act of adding it; one added anywhere else fails the test.
 */
export const API_CONTROLLERS = [
  AgentsController,
  AuthController,
  CallsController,
  ConfigController,
  CredentialsController,
  EventSubscriptionsController,
  InvitationsController,
  KnowledgeController,
  MembersController,
  NumbersController,
  OrganizationController,
  ReadinessController,
  TestCallController,
  ToolsController,
  VoicesController,
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
    {
      /**
       * The one thing besides `OrganizationGateway` that is handed the pool, and it is handed it
       * here for the same reason the gateway is: this module is the wiring, and
       * `routes.test.ts` exempts it from the scan that keeps `API_DATA_SOURCE` out of every
       * other file. `origination.ts` does not query with it — it passes it to
       * `placeOutboundCall`, which needs one to read the consent record inside the organization's
       * own scope.
       */
      provide: ORIGINATION,
      inject: [API_DATA_SOURCE],
      useFactory: (dataSource: Db | null) =>
        createOrigination({ dataSource, log: createLogger({ component: "api-testcall" }) }),
    },
    OrganizationGateway,
    OrganizationContext,
    AuthService,

    /* One mailer for the process. It resolves its provider from the environment at
       construction, so a deployment with no keys gets the logging one and every send reports
       "not sent" rather than throwing — see `mailer.ts` for why that is the right default. */
    {
      provide: MAILER,
      /* Its own logger, named for what it is. There is no LOGGER token in this module — the
         call path has one, and reaching across for it would couple the dashboard's mail to
         telephony's wiring for nothing. */
      useFactory: (): Mailer => createMailer(createLogger({ component: "api-mail" })),
    },

    /* Order matters, and only for the guards. The anti-abuse limiter runs first so that the
       endpoints it protects are throttled before they spend a hundred milliseconds of scrypt;
       ApiGuard then authenticates and authorises; and the organisation quota runs last,
       because it is the only one of the three that needs to know who is calling. Reversing
       the first and second would let a guessing attack pay for scrypt on every attempt. */
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: ApiGuard },
    { provide: APP_GUARD, useClass: OrganizationRateLimitGuard },
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
