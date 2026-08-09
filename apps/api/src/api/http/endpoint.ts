import { applyDecorators, HttpCode, SetMetadata } from "@nestjs/common";

import type { Capability } from "../auth/capability";
import type { Schema } from "./schema";

/**
 * Everything about a route that is not its implementation, declared once, next to it.
 *
 * The guard reads `capability` from here. The interceptor reads `query`, `body`, `params`
 * and `response` from here. The OpenAPI generator reads all of it from here. So a route
 * cannot be documented as requiring one capability and enforce another, and cannot
 * publish a response shape it does not actually return.
 *
 * **A route under the API prefix without this decorator does not run.** The guard treats
 * a missing spec as a misconfiguration and refuses the request rather than guessing, and
 * `routes.test.ts` fails the build before it gets that far. Forgetting it is loud in both
 * directions, which is the only reason it is safe for it to be a decorator at all.
 */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
  /**
   * `ip` alone is right for an endpoint anyone may call. `ip+email` additionally caps
   * attempts against a single account, so one address behind a shared NAT cannot be
   * brute-forced by exhausting nobody's quota but their own.
   */
  readonly by: "ip" | "ip+email";
}

export interface EndpointSpec {
  /** One line, imperative. Becomes the OpenAPI `summary` and the client method's doc. */
  readonly summary: string;
  readonly description?: string;
  /**
   * `"public"` means no session is required — currently sign-in and invitation
   * acceptance, and nothing else. `"authenticated"` means any member of the organisation,
   * for the handful of routes that are about the caller themselves rather than about the
   * organisation's data. Everything else names the capability it needs.
   *
   * There is no default. Adding a route without deciding this is a 500 at runtime and a
   * failing test at build time, because "I did not think about access control" and
   * "everyone may call this" must not look the same in a diff.
   */
  readonly capability: Capability | "public" | "authenticated";
  readonly params?: Schema<unknown>;
  readonly query?: Schema<unknown>;
  readonly body?: Schema<unknown>;
  /** Omitted means the endpoint returns nothing, and the status becomes 204. */
  readonly response?: Schema<unknown>;
  /** Defaults to 200, or 204 when there is no response. Set 201 on a create. */
  readonly status?: number;
  readonly rateLimit?: RateLimitRule;
}

/** Not exported: the two readers of this metadata are `Endpoint` and `specOf`, below. */
const ENDPOINT_SPEC = "ansa:endpoint";

export const statusOf = (spec: EndpointSpec): number =>
  spec.status ?? (spec.response === undefined ? 204 : 200);

/**
 * Also sets Nest's status code, because Nest resolves that from its own metadata before
 * any interceptor of ours runs — assigning `res.statusCode` later is overwritten. Doing
 * it here is what keeps the documented status and the returned status the same number:
 * without it, Nest's default of 201-for-POST would quietly contradict the spec.
 */
export const Endpoint = (spec: EndpointSpec): MethodDecorator =>
  applyDecorators(SetMetadata(ENDPOINT_SPEC, spec), HttpCode(statusOf(spec)));

/**
 * Reads the spec straight off the handler.
 *
 * A plain `Reflect.getMetadata` rather than Nest's `Reflector`, because the OpenAPI
 * generator walks controller classes without an application context and needs the same
 * answer the guard gets. One reader, one answer.
 */
export const specOf = (handler: object): EndpointSpec | undefined =>
  Reflect.getMetadata(ENDPOINT_SPEC, handler) as EndpointSpec | undefined;
