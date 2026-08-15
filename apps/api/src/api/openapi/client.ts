import type { JsonSchema } from "../http/schema";

/**
 * The frontend's client, generated from `openapi.json`.
 *
 * Written here, in TypeScript, rather than as a script under `tools/` for one reason: this
 * way it is typechecked, linted and unit-tested like everything else, and the script that
 * writes the file to disk is four lines that call it. A generator nobody tests produces a
 * client nobody trusts.
 *
 * It handles exactly the subset of OpenAPI that `http/schema.ts` can express, which is not
 * a limitation so much as the same decision stated twice: if an endpoint cannot be
 * described in that subset, its client method could not have been generated either, and
 * the place to fix that is the schema language.
 */

const literal = (value: string): string => JSON.stringify(value);

/**
 * An operation id's tag as a property name on the client.
 *
 * Tags come from `operationId` and two of them are hyphenated — `test-calls`,
 * `event-subscriptions` — which is fine in a spec and is a syntax error in an object
 * literal. Emitting them raw produced a client that had never once compiled, and nothing
 * noticed because nothing consumed the output until a frontend existed.
 *
 * Camel case rather than quoting, because the alternative reads `client["test-calls"]` at
 * every call site for the lifetime of the API. The tag is a naming choice on this side of
 * the wire; the operation id in the spec is unchanged and is still the contract.
 */
const propertyName = (tag: string): string =>
  tag.replace(/[-_](.)/g, (_, character: string) => character.toUpperCase());

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const indent = (text: string, depth: number): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `${"  ".repeat(depth)}${line}`))
    .join("\n");

/** Indents every line but the first, for a multi-line type spliced into an existing line. */
const reindent = (text: string, depth: number): string => indent(text, depth).trimStart();

/** A JSON Schema from our own subset, as a TypeScript type. */
export const tsType = (schema: unknown): string => {
  if (!isRecord(schema)) return "unknown";
  if (typeof schema["$ref"] === "string") return "Problem";

  const raw = schema["type"];
  const nullable = Array.isArray(raw) && raw.includes("null");
  const type = Array.isArray(raw) ? raw.find((each) => each !== "null") : raw;
  const suffix = nullable ? " | null" : "";

  if (Array.isArray(schema["enum"])) {
    return `${schema["enum"].filter((v): v is string => typeof v === "string").map(literal).join(" | ")}${suffix}`;
  }

  switch (type) {
    case "string":
      return `string${suffix}`;
    case "integer":
    case "number":
      return `number${suffix}`;
    case "boolean":
      return `boolean${suffix}`;
    case "array":
      // Always parenthesised. `readonly "a" | "b"[]` is a syntax error and
      // `readonly {…}[]` binds the wrong way; the parentheses cost nothing when the item
      // type is a single word and are required as soon as it is a union or an object.
      return `readonly (${tsType(schema["items"])})[]${suffix}`;
    case "object": {
      const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
      const required = new Set(
        Array.isArray(schema["required"]) ? schema["required"].filter((k): k is string => typeof k === "string") : [],
      );
      const entries = Object.entries(properties);
      if (entries.length === 0) return `Record<string, never>${suffix}`;
      const fields = entries
        .map(([name, child]) => `  readonly ${name}${required.has(name) ? "" : "?"}: ${tsType(child)};`)
        .join("\n");
      return `{\n${fields}\n}${suffix}`;
    }
    default:
      return `unknown${suffix}`;
  }
};

interface Parameter {
  readonly name: string;
  readonly location: string;
  readonly required: boolean;
  readonly schema: unknown;
}

const parametersOf = (operation: Record<string, unknown>): readonly Parameter[] => {
  const raw = operation["parameters"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((parameter) => ({
    name: String(parameter["name"]),
    location: String(parameter["in"]),
    required: parameter["required"] === true,
    schema: parameter["schema"],
  }));
};

const bodySchemaOf = (operation: Record<string, unknown>): unknown => {
  const body = operation["requestBody"];
  if (!isRecord(body)) return undefined;
  const content = body["content"];
  if (!isRecord(content)) return undefined;
  const json = content["application/json"];
  return isRecord(json) ? json["schema"] : undefined;
};

/** The success response — the one 2xx entry. Everything else is a `Problem`. */
const successOf = (operation: Record<string, unknown>): { status: number; schema: unknown } => {
  const responses = isRecord(operation["responses"]) ? operation["responses"] : {};
  for (const [status, response] of Object.entries(responses)) {
    const code = Number(status);
    if (code < 200 || code >= 300 || !isRecord(response)) continue;
    const content = response["content"];
    const json = isRecord(content) ? content["application/json"] : undefined;
    return { status: code, schema: isRecord(json) ? json["schema"] : undefined };
  }
  return { status: 204, schema: undefined };
};

const inputType = (parameters: readonly Parameter[], body: unknown): string | null => {
  const path = parameters.filter((p) => p.location === "path");
  const query = parameters.filter((p) => p.location === "query");
  const parts: string[] = [];

  if (path.length > 0) {
    parts.push(`  readonly path: {\n${path.map((p) => `    readonly ${p.name}: ${tsType(p.schema)};`).join("\n")}\n  };`);
  }
  if (query.length > 0) {
    const optional = query.every((p) => !p.required) ? "?" : "";
    parts.push(
      `  readonly query${optional}: {\n${query.map((p) => `    readonly ${p.name}${p.required ? "" : "?"}: ${tsType(p.schema)};`).join("\n")}\n  };`,
    );
  }
  if (body !== undefined) parts.push(`  readonly body: ${reindent(tsType(body), 1)};`);

  return parts.length === 0 ? null : `{\n${parts.join("\n")}\n}`;
};

/** `/api/v1/members/{userId}` becomes a template literal reading from `input.path`. */
const pathExpression = (path: string): string =>
  `\`${path.replace(/\{([A-Za-z0-9_]+)\}/g, "${encodeURIComponent(input.path.$1)}")}\``;

const PREAMBLE = `// Generated from openapi.json by \`pnpm --filter @ansa/api openapi\`. Do not edit.
//
// One file, no dependencies, fetch only. Every method throws \`AnsaApiError\` on a
// non-2xx response, carrying the RFC 9457 problem document the API returned.

export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly requestId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

export class AnsaApiError extends Error {
  constructor(readonly problem: Problem) {
    super(\`\${problem.title}\${problem.detail === undefined ? "" : \`: \${problem.detail}\`}\`);
    this.name = "AnsaApiError";
  }
}

export interface AnsaClientOptions {
  readonly baseUrl: string;
  /**
   * The session token. A function rather than a string so a client created once can
   * follow a sign-in and a sign-out without being rebuilt.
   */
  readonly token?: () => string | null;
  readonly fetch?: typeof fetch;
}

interface RequestInput {
  // Not every path parameter is a string: the configuration version endpoints take an
  // integer, and narrowing this to string made the generated file fail to compile at the
  // two call sites that pass one. encodeURIComponent accepts both, so widening is the fix.
  readonly path?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}
`;

const RUNTIME = `const send = async <T>(
  options: AnsaClientOptions,
  method: string,
  path: string,
  input: RequestInput,
): Promise<T> => {
  const url = new URL(\`\${options.baseUrl.replace(/\\/+$/, "")}\${path}\`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const token = options.token?.() ?? null;
  const response = await (options.fetch ?? fetch)(url, {
    method,
    headers: {
      accept: "application/json",
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === null ? {} : { authorization: \`Bearer \${token}\` }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => undefined);
  if (response.ok) return payload as T;

  throw new AnsaApiError(
    (payload as Problem | undefined) ?? {
      type: "urn:ansa:problem:error",
      title: "Request failed",
      status: response.status,
    },
  );
};
`;

export const renderClient = (document: JsonSchema): string => {
  const paths = isRecord(document["paths"]) ? document["paths"] : {};
  const groups = new Map<string, string[]>();

  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) continue;
    for (const [method, raw] of Object.entries(item)) {
      if (!isRecord(raw)) continue;
      const [tag, name] = String(raw["operationId"] ?? "").split(".");
      if (tag === undefined || name === undefined) continue;

      const parameters = parametersOf(raw);
      const body = bodySchemaOf(raw);
      const input = inputType(parameters, body);
      const success = successOf(raw);
      const returns = success.schema === undefined ? "void" : reindent(tsType(success.schema), 1);

      // The return type appears once, as `send`'s type argument, and the method's own type
      // is inferred from it. Writing it twice — annotation and cast — is how a generated
      // client ends up with two shapes for one response.
      const signature = input === null ? "()" : `(input: ${reindent(input, 1)})`;
      const argument = input === null ? "{}" : "input";
      const doc = [raw["summary"], raw["description"]].filter((line) => typeof line === "string");

      const lines = [
        `/**\n${doc.map((line) => ` * ${String(line)}`).join("\n")}\n */`,
        `${name}: ${signature} =>`,
        `  send<${returns}>(options, ${literal(method.toUpperCase())}, ${pathExpression(path)}, ${argument}),`,
      ].join("\n");

      const group = groups.get(tag) ?? [];
      group.push(lines);
      groups.set(tag, group);
    }
  }

  const areas = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, methods]) => `${propertyName(tag)}: {\n${indent(methods.join("\n\n"), 1)}\n},`)
    .join("\n\n");

  return `${PREAMBLE}
${RUNTIME}
export const createAnsaClient = (options: AnsaClientOptions) => ({
${indent(areas, 1)}
});

export type AnsaClient = ReturnType<typeof createAnsaClient>;
`;
};
