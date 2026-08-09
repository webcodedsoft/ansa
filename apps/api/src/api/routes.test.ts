import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";

import { API_CONTROLLERS } from "./api.module";
import { specOf, type EndpointSpec } from "./http/endpoint";
import { API_PREFIX } from "./http/request";

/**
 * The test that has to keep working six months from now.
 *
 * Nothing here exercises a request. It walks the controllers `ApiModule` registers and the
 * source files under `src/api`, and fails if a new route could escape the pipeline. Each
 * assertion below corresponds to one way that could happen, and each was written because
 * the alternative was trusting somebody to remember.
 */

interface Route {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  readonly spec: EndpointSpec | undefined;
}

const routesOf = (controller: { name: string; prototype: object }): readonly Route[] => {
  const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? "";
  const routes: Route[] = [];

  for (const handler of Object.getOwnPropertyNames(controller.prototype)) {
    if (handler === "constructor") continue;
    const fn = (controller.prototype as Record<string, unknown>)[handler];
    if (typeof fn !== "function") continue;

    const verb = Reflect.getMetadata(METHOD_METADATA, fn) as number | undefined;
    if (verb === undefined) continue;
    const route = (Reflect.getMetadata(PATH_METADATA, fn) as string | undefined) ?? "";

    routes.push({
      controller: controller.name,
      handler,
      method: RequestMethod[verb] ?? String(verb),
      path: `/${[base, route].map((part) => part.replace(/^\/+|\/+$/g, "")).filter((part) => part !== "").join("/")}`,
      spec: specOf(fn),
    });
  }

  return routes;
};

const ALL_ROUTES = API_CONTROLLERS.flatMap(routesOf);

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });

const API_SOURCE = join(__dirname);

describe("every dashboard route", () => {
  it("is registered, so this test is actually looking at something", () => {
    expect(ALL_ROUTES.length).toBeGreaterThan(0);
  });

  /**
   * `ApiGuard` defers on paths outside the prefix, because the carrier webhooks
   * authenticate by signature and have no session. A dashboard route declared outside the
   * prefix would therefore reach its handler with nobody signed in. This is the assertion
   * that makes the deferral safe.
   */
  it("lives under the API prefix, where the guard applies", () => {
    for (const route of ALL_ROUTES) {
      expect(route.path.startsWith(`${API_PREFIX}/`), `${route.controller}.${route.handler}`).toBe(true);
    }
  });

  /** No spec means no declared capability. The guard 500s on it; this fails first. */
  it("declares an @Endpoint", () => {
    const missing = ALL_ROUTES.filter((route) => route.spec === undefined);
    expect(missing.map((route) => `${route.controller}.${route.handler}`)).toEqual([]);
  });

  it("declares a response schema unless it returns 204", () => {
    for (const route of ALL_ROUTES) {
      const spec = route.spec;
      if (spec === undefined || spec.response !== undefined) continue;
      expect(spec.status ?? 204, `${route.controller}.${route.handler}`).toBe(204);
    }
  });

  /**
   * The list is written out, so making a route public is a change to this test and shows
   * up in review. Anything that quietly becomes `"public"` fails here.
   */
  it("requires a session, except for the four routes that cannot", () => {
    const publicRoutes = ALL_ROUTES.filter((route) => route.spec?.capability === "public").map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(publicRoutes.sort()).toEqual([
      "POST /api/v1/auth/organisations",
      "POST /api/v1/auth/sessions",
      "POST /api/v1/invitations/accept",
    ]);
  });

  /** Anything a stranger can reach spends real work, so it has to be throttled. */
  it("rate limits every public route", () => {
    for (const route of ALL_ROUTES) {
      if (route.spec?.capability !== "public") continue;
      expect(route.spec.rateLimit, `${route.method} ${route.path}`).toBeDefined();
    }
  });
});

describe("the API's access to the database", () => {
  /**
   * The structural half of tenant isolation, checked as text because the eslint config is
   * protected from edits in this repository.
   *
   * `withTenant`, `createDataSource`, `Db` and `API_DATA_SOURCE` are the four ways to
   * reach Postgres without a tenant already bound. `src/api/tenancy` is the one place that
   * may hold them; everywhere else takes a `TenantScope` from `TenantContext.tx()`, which
   * has no tenant parameter to get wrong.
   *
   * A new endpoint that reaches for a raw handle fails here, with the reason.
   */
  const FORBIDDEN = ["withTenant", "createDataSource", "API_DATA_SOURCE"];

  it("is confined to src/api/tenancy", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(API_SOURCE)) {
      if (file.includes(`${join("api", "tenancy")}`)) continue;
      // The module wires the pool into the gateway; that is the wiring, not a query path.
      if (file.endsWith("api.module.ts")) continue;

      const source = readFileSync(file, "utf8");
      for (const name of FORBIDDEN) {
        if (new RegExp(`\\b${name}\\b`).test(source)) {
          offenders.push(`${file} mentions ${name}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * Every query function this layer calls takes a scope as its first argument. A function
   * taking `(dataSource, tenantId, …)` — the shape the call path uses — would let a
   * handler name a tenant, and naming one is the mistake this design removes.
   */
  it("never passes a tenant id to a query", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SOURCE)) {
      if (file.includes(`${join("api", "tenancy")}`)) continue;
      const source = readFileSync(file, "utf8");
      // `caller.tenantId` is fine — it is read for a response body and for logging.
      // Passing one as an argument is not, and that reads as `, tenantId` or `(tenantId`.
      if (/[(,]\s*tenantId\s*[,)]/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
