import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";

import { ALL_CAPABILITIES } from "../auth/capability";
import { specOf, statusOf, type EndpointSpec } from "../http/endpoint";
import { PROBLEM_TYPE_PREFIX } from "../http/problem";
import { API_PREFIX } from "../http/request";
import { toJsonSchema, type JsonSchema, type SchemaNode } from "../http/schema";

/**
 * `openapi.json`, built by reading the controllers.
 *
 * The spec is not written down anywhere. It is derived from the same `@Endpoint`
 * decorators the guard and the interceptor read at runtime, so the three cannot disagree:
 * an operation documented as requiring `members:write` requires it because that is the
 * value the guard checked, and a documented response shape is the shape the interceptor
 * projected the handler's return value through.
 *
 * `openapi.test.ts` compares the committed file against a fresh build and fails if they
 * differ, which is what stops the spec from being edited by hand into something the code
 * does not do.
 */

interface ControllerClass {
  readonly name: string;
  readonly prototype: object;
}

const VERB: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: "get",
  [RequestMethod.POST]: "post",
  [RequestMethod.PUT]: "put",
  [RequestMethod.DELETE]: "delete",
  [RequestMethod.PATCH]: "patch",
};

/** `users/:userId` as Nest writes it becomes `users/{userId}` as OpenAPI wants it. */
const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

const joinPath = (base: string, route: string): string => {
  const parts = [base, route].map((part) => part.replace(/^\/+|\/+$/g, "")).filter((part) => part !== "");
  return `/${parts.join("/")}`;
};

const objectProperties = (node: SchemaNode | undefined): readonly [string, SchemaNode][] =>
  node !== undefined && node.type === "object" ? Object.entries(node.properties) : [];

const parametersFor = (spec: EndpointSpec): readonly JsonSchema[] => [
  ...objectProperties(spec.params?.node).map(([name, child]) => ({
    name,
    in: "path",
    required: true,
    schema: toJsonSchema(child),
  })),
  ...objectProperties(spec.query?.node).map(([name, child]) => ({
    name,
    in: "query",
    required: child.optional !== true,
    schema: toJsonSchema(child),
  })),
];

const PROBLEM_REF = { $ref: "#/components/schemas/Problem" };

const problemResponse = (description: string): JsonSchema => ({
  description,
  content: { "application/problem+json": { schema: PROBLEM_REF } },
});

/**
 * Which failures an operation can produce, derived rather than listed.
 *
 * Every one of these is a consequence of something already declared: input schemas mean a
 * 422 is possible, a capability means 401 and 403 are, a rate limit means 429 is. Listing
 * them by hand would let an operation document a 403 it cannot return and omit one it can.
 */
const responsesFor = (spec: EndpointSpec): JsonSchema => {
  const success: JsonSchema =
    spec.response === undefined
      ? { description: "No content" }
      : {
          description: "Success",
          content: { "application/json": { schema: toJsonSchema(spec.response.node) } },
        };

  const failures: Record<string, JsonSchema> = {};
  if (spec.params !== undefined || spec.query !== undefined || spec.body !== undefined) {
    failures["422"] = problemResponse("The request did not match this endpoint's schema");
  }
  if (spec.capability !== "public") {
    failures["401"] = problemResponse("No session, or a session that is no longer valid");
  }
  if (spec.capability !== "public" && spec.capability !== "authenticated") {
    failures["403"] = problemResponse(`The caller's role does not hold ${spec.capability}`);
  }
  if (spec.params !== undefined) {
    failures["404"] = problemResponse("No such record in this organisation");
  }
  if (spec.rateLimit !== undefined) {
    failures["429"] = problemResponse("Too many attempts; see the Retry-After header");
  }

  return {
    [String(statusOf(spec))]: success,
    ...failures,
    "500": problemResponse("Something went wrong"),
    "503": problemResponse("The database is unreachable"),
  };
};

const operationFor = (spec: EndpointSpec, tag: string, name: string): JsonSchema => ({
  operationId: `${tag}.${name}`,
  tags: [tag],
  summary: spec.summary,
  ...(spec.description === undefined ? {} : { description: spec.description }),
  // A capability is a value, so it can be published. A client that knows what a route
  // needs can hide the button rather than discover a 403.
  "x-ansa-capability": spec.capability,
  ...(spec.capability === "public" ? { security: [] } : {}),
  ...(parametersFor(spec).length === 0 ? {} : { parameters: parametersFor(spec) }),
  ...(spec.body === undefined
    ? {}
    : {
        requestBody: {
          required: true,
          content: { "application/json": { schema: toJsonSchema(spec.body.node) } },
        },
      }),
  responses: responsesFor(spec),
});

const handlersOf = (controller: ControllerClass): readonly [string, EndpointSpec, string, string][] => {
  const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? "";
  const found: [string, EndpointSpec, string, string][] = [];

  for (const name of Object.getOwnPropertyNames(controller.prototype)) {
    if (name === "constructor") continue;
    const handler = (controller.prototype as Record<string, unknown>)[name];
    if (typeof handler !== "function") continue;

    const spec = specOf(handler);
    const route = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
    const verb = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    if (spec === undefined || route === undefined || verb === undefined) continue;

    const method = VERB[verb];
    if (method === undefined) continue;
    found.push([toOpenApiPath(joinPath(base, route)), spec, method, name]);
  }

  return found;
};

/** Everything a caller may see about themselves, for the `Problem` component. */
const PROBLEM_SCHEMA: JsonSchema = {
  type: "object",
  description: "RFC 9457. Every error from this API has this shape.",
  properties: {
    type: { type: "string", description: `Stable identifier, prefixed \`${PROBLEM_TYPE_PREFIX}\`` },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    requestId: { type: "string", description: "Echoed in the X-Request-Id header" },
    errors: {
      type: "array",
      description: "Present on 422 only, one entry per field that did not validate",
      items: {
        type: "object",
        properties: { path: { type: "string" }, message: { type: "string" } },
        required: ["path", "message"],
        additionalProperties: false,
      },
    },
  },
  required: ["type", "title", "status"],
  additionalProperties: false,
};

export interface DocumentInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

/** Where the committed contract lives, relative to the package root. */
export const SPEC_PATH = "openapi.json";

/**
 * The version is the URL's, derived from `API_PREFIX` rather than written twice. A spec
 * whose version disagrees with the path it documents is a spec people stop believing.
 */
export const specInfo = (): DocumentInfo => ({
  title: "Ansa dashboard API",
  version: API_PREFIX.split("/").filter((part) => part !== "").pop() ?? "v1",
  description:
    "Self-service for a organization organisation: its people, its agent's configuration, and its call history. Every request is scoped to one organisation by the session token that made it.",
});

export const buildDocument = (
  controllers: readonly ControllerClass[],
  info: DocumentInfo,
): JsonSchema => {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  const tags = new Set<string>();

  for (const controller of controllers) {
    // The last segment of the controller's path: `api/v1/members` tags as `members`, which
    // is what groups the generated client's methods.
    const base = (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? "";
    const tag = base.split("/").filter((part) => part !== "").pop() ?? controller.name;
    tags.add(tag);

    for (const [path, spec, method, name] of handlersOf(controller)) {
      paths[path] ??= {};
      (paths[path] as Record<string, JsonSchema>)[method] = operationFor(spec, tag, name);
    }
  }

  return {
    openapi: "3.1.0",
    info,
    tags: [...tags].sort().map((name) => ({ name })),
    // Sorted, so regenerating after an unrelated change produces no diff. An
    // "is the spec current" test is only useful if the output is deterministic.
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
    components: {
      securitySchemes: {
        session: {
          type: "http",
          scheme: "bearer",
          description:
            "The token from POST /api/v1/auth/sessions. It names the organisation it belongs to, so no other header selects one.",
        },
      },
      schemas: { Problem: PROBLEM_SCHEMA },
    },
    security: [{ session: [] }],
    "x-ansa-capabilities": ALL_CAPABILITIES,
  };
};
