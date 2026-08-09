import { randomUUID } from "node:crypto";

import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

/**
 * The request, as the API layer is allowed to see it.
 *
 * Structural rather than `express.Request` for the same reason nothing imports a vendor
 * SDK outside `packages/providers` — and for one practical reason too: Express 5 made
 * `req.query` a getter, so code that assigned to it silently stopped working. Nothing
 * here assigns to the framework's own properties; validated values live under our own
 * symbol and are read through the decorators below.
 */
export interface ApiRequest {
  readonly method: string;
  readonly originalUrl: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly params?: unknown;
  readonly socket?: { readonly remoteAddress?: string | undefined };
  /** Set by the middleware and interceptors below. Nothing else writes to the request. */
  ansa?: RequestState;
}

export interface RequestState {
  readonly requestId: string;
  validated?: { readonly params: unknown; readonly query: unknown; readonly body: unknown };
  /** Set by SessionGuard once the token has resolved to a real, live session. */
  principal?: unknown;
}

/** The API prefix. Every dashboard route lives under it, and the guards key off it. */
export const API_PREFIX = "/api/v1";

/**
 * The `@Controller()` path for one area of the dashboard.
 *
 * Written as a call rather than a string literal so the prefix exists once. `routes.test.ts`
 * fails the build if any controller in `ApiModule` ends up outside it, because a route
 * outside the prefix is a route `ApiGuard` defers on — which is the one way a dashboard
 * endpoint could reach a handler unauthenticated.
 */
export const apiRoute = (area: string): string => `${API_PREFIX.slice(1)}/${area}`;

export const isApiPath = (url: string): boolean => {
  const path = url.split("?")[0] ?? "";
  return path === API_PREFIX || path.startsWith(`${API_PREFIX}/`);
};

/**
 * The per-request scratch space, created on first use.
 *
 * Lazy rather than middleware-only so that a controller wired up without the middleware
 * still authenticates correctly and merely loses its `X-Request-Id` header. The failure
 * mode of the alternative — throwing — would be a 500 on a route that was otherwise fine,
 * which is a worse trade for a diagnostic field.
 */
export const stateOf = (request: ApiRequest): RequestState =>
  (request.ansa ??= { requestId: randomUUID() });

/**
 * Who to count a rate limit against.
 *
 * The socket's peer, deliberately, and not `X-Forwarded-For`. A header any client can set
 * is not an identity, and a limiter keyed on one is a limiter with an off switch. The cost
 * is that everyone behind a shared NAT shares a bucket; the limits here are set with that
 * in mind. When this sits behind a proxy we control, this is the one function to change.
 */
export const clientAddress = (request: ApiRequest): string =>
  request.socket?.remoteAddress ?? "unknown";

const validatedPart = (part: "params" | "query" | "body") =>
  createParamDecorator((_data: unknown, context: ExecutionContext): unknown => {
    const request = context.switchToHttp().getRequest<ApiRequest>();
    const validated = stateOf(request).validated;
    // Reachable only if the interceptor did not run for this handler, which means the
    // handler would otherwise receive unvalidated input. Fail rather than hand it over.
    if (validated === undefined) throw new Error("request was not validated: the API interceptor did not run");
    return validated[part];
  });

/**
 * Validated input, and the only way a handler may read any.
 *
 * Nest's own `@Body()` and `@Query()` hand over whatever arrived. These hand over what the
 * endpoint's schema produced, already coerced and already rejected if wrong — so a handler
 * parameter typed `Infer<typeof createInvitation>` is telling the truth.
 */
export const FromPath = validatedPart("params");
export const FromQuery = validatedPart("query");
export const FromBody = validatedPart("body");
