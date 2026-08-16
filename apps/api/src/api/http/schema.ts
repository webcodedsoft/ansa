/**
 * The one description of a request or response shape, used three times.
 *
 * A schema declared beside a handler is (1) what validates the incoming request, (2) what
 * the outgoing response is projected through, and (3) what appears in `openapi.json` and
 * therefore in the generated client. Those three cannot drift, because there is only one
 * of them.
 *
 * That is the entire reason this exists rather than a validation library plus a decorator
 * library. Two libraries means two declarations of the same shape and a convention that
 * they be kept in step — and the failure mode is a spec that lies, which is worse than no
 * spec because the frontend's types come from it.
 *
 * It is deliberately small: strings, integers, booleans, enums, objects, arrays, and
 * `optional`/`nullable` wrappers. Everything the dashboard needs is expressible in that,
 * and each thing it cannot express is a thing the generated client would not have handled
 * either. Grow it when an endpoint genuinely needs more, not in anticipation.
 */

export type SchemaNode =
  | { readonly type: "string"; readonly format?: string; readonly minLength?: number; readonly maxLength?: number; readonly pattern?: string; readonly enum?: readonly string[]; readonly nullable?: boolean; readonly optional?: boolean }
  | { readonly type: "integer"; readonly minimum?: number; readonly maximum?: number; readonly nullable?: boolean; readonly optional?: boolean }
  | { readonly type: "number"; readonly minimum?: number; readonly maximum?: number; readonly nullable?: boolean; readonly optional?: boolean }
  | { readonly type: "boolean"; readonly nullable?: boolean; readonly optional?: boolean }
  | { readonly type: "array"; readonly items: SchemaNode; readonly maxItems?: number; readonly nullable?: boolean; readonly optional?: boolean }
  | { readonly type: "object"; readonly properties: Readonly<Record<string, SchemaNode>>; readonly nullable?: boolean; readonly optional?: boolean }
  /** Keys the caller chooses — headers, where the names belong to somebody else's API. */
  | { readonly type: "object"; readonly additionalProperties: SchemaNode; readonly maxProperties?: number; readonly nullable?: boolean; readonly optional?: boolean };

/**
 * A schema carrying the type it produces.
 *
 * `_out` is never assigned — it exists so `Infer` has something to read. Marked optional
 * and readonly so nothing is tempted to look at it at runtime.
 */
export interface Schema<T> {
  readonly node: SchemaNode;
  readonly _out?: T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Props = Readonly<Record<string, Schema<unknown>>>;

/**
 * Optionality is read off the output type rather than tracked separately: `optional()`
 * adds `undefined` to it, and a key whose type admits `undefined` becomes an optional key.
 * One source of truth for a property being optional, at the type level and at runtime.
 */
type ObjectOut<P extends Props> = {
  [K in keyof P as undefined extends Infer<P[K]> ? never : K]: Infer<P[K]>;
} & {
  [K in keyof P as undefined extends Infer<P[K]> ? K : never]?: Infer<P[K]>;
};

export interface TextOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  /** OpenAPI `format`, e.g. `email`, `uuid`, `date-time`. Documentation only. */
  readonly format?: string;
}

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export const text = (options: TextOptions = {}): Schema<string> => ({
  node: defined({
    type: "string" as const,
    minLength: options.minLength,
    maxLength: options.maxLength,
    pattern: options.pattern?.source,
    format: options.format,
  }),
});

export const choice = <const T extends string>(values: readonly T[]): Schema<T> => ({
  node: { type: "string", enum: values },
});

export const integer = (options: { readonly minimum?: number; readonly maximum?: number } = {}): Schema<number> => ({
  node: defined({ type: "integer" as const, minimum: options.minimum, maximum: options.maximum }),
});

/**
 * A number that need not be whole — a speaking rate, a threshold, a ratio.
 *
 * Separate from `integer` rather than a flag on it, because the two refuse different things
 * and a caller reading the schema should be able to tell at a glance which one a field is.
 */
export const number = (
  options: { readonly minimum?: number; readonly maximum?: number } = {},
): Schema<number> => ({
  node: defined({ type: "number" as const, minimum: options.minimum, maximum: options.maximum }),
});

export const flag = (): Schema<boolean> => ({ node: { type: "boolean" } });

export const list = <T>(items: Schema<T>, options: { readonly maxItems?: number } = {}): Schema<readonly T[]> => ({
  node: defined({ type: "array" as const, items: items.node, maxItems: options.maxItems }),
});

/**
 * An object with a fixed value type and keys nobody declared in advance.
 *
 * For headers, where the names belong to the organisation's endpoint rather than to us.
 * `object` cannot express it — every key there is known at schema time. Key *shape* is not
 * checked here: `parseConnectorConfig` refuses a name that is not a header token, and one
 * rule in one place beats a weaker copy of it in two.
 */
export const map = <T>(
  values: Schema<T>,
  options: { readonly maxProperties?: number } = {},
): Schema<Readonly<Record<string, T>>> => ({
  node: defined({
    type: "object" as const,
    additionalProperties: values.node,
    maxProperties: options.maxProperties,
  }),
});

export const object = <const P extends Props>(properties: P): Schema<ObjectOut<P>> => ({
  node: {
    type: "object",
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [key, schema.node]),
    ),
  },
});

export const optional = <T>(schema: Schema<T>): Schema<T | undefined> => ({
  node: { ...schema.node, optional: true },
});

export const nullable = <T>(schema: Schema<T>): Schema<T | null> => ({
  node: { ...schema.node, nullable: true },
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FieldError {
  /** Dotted path from the root of the value, e.g. `role` or `items.0.email`. */
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface ParseOptions {
  /**
   * Query strings and path parameters arrive as strings, so `limit=25` has to become the
   * number 25. JSON bodies do not need it and must not get it: a body that sends `"25"`
   * for an integer is a client bug, and silently accepting it hides the bug until the day
   * something sends `"25 "`.
   */
  readonly coerce?: boolean;
  /**
   * `reject` for input — a misspelled field is a mistake the caller wants to hear about,
   * not one to swallow. `strip` for output, where it is an allowlist: a column added to a
   * table cannot leak through an endpoint that was not updated to expose it.
   */
  readonly unknown: "reject" | "strip";
}

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** "1 character", not "1 characters". The message is read by a person, not by a parser. */
const characters = (count: number): string => `${count} character${count === 1 ? "" : "s"}`;

const fail = (path: string, message: string): ParseResult<never> => ({
  ok: false,
  errors: [{ path, message }],
});

const parseString = (node: Extract<SchemaNode, { type: "string" }>, value: unknown, path: string): ParseResult<unknown> => {
  if (typeof value !== "string") return fail(path, "must be a string");
  if (node.enum !== undefined && !node.enum.includes(value)) {
    return fail(path, `must be one of: ${node.enum.join(", ")}`);
  }
  if (node.minLength !== undefined && value.length < node.minLength) {
    /* "must be at least 1 characters" is two mistakes in one short line, and it is the
       message a person meets most often, because `minLength: 1` is how every required text
       field in this API is written. An empty box is not a length problem to whoever left it
       empty — it is a missing answer, and that is what it should say. */
    return fail(
      path,
      node.minLength === 1 ? "is required" : `must be at least ${characters(node.minLength)}`,
    );
  }
  if (node.maxLength !== undefined && value.length > node.maxLength) {
    return fail(path, `must be at most ${characters(node.maxLength)}`);
  }
  if (node.pattern !== undefined && !new RegExp(node.pattern).test(value)) {
    return fail(path, "is not in the expected format");
  }
  return { ok: true, value };
};

const parseInteger = (node: Extract<SchemaNode, { type: "integer" }>, raw: unknown, path: string, coerce: boolean): ParseResult<unknown> => {
  const value = coerce && typeof raw === "string" && /^-?\d+$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isInteger(value)) return fail(path, "must be an integer");
  if (node.minimum !== undefined && value < node.minimum) return fail(path, `must be at least ${node.minimum}`);
  if (node.maximum !== undefined && value > node.maximum) return fail(path, `must be at most ${node.maximum}`);
  return { ok: true, value };
};

/** Fractional, unlike `parseInteger`. Coerced from a string for query parameters. */
const parseNumber = (
  node: { readonly minimum?: number; readonly maximum?: number },
  raw: unknown,
  path: string,
  coerce: boolean,
): ParseResult<unknown> => {
  const value = coerce && typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "must be a number");
  if (node.minimum !== undefined && value < node.minimum) {
    return fail(path, `must be at least ${node.minimum}`);
  }
  if (node.maximum !== undefined && value > node.maximum) {
    return fail(path, `must be at most ${node.maximum}`);
  }
  return { ok: true, value };
};

const parseBoolean = (raw: unknown, path: string, coerce: boolean): ParseResult<unknown> => {
  const value = coerce && (raw === "true" || raw === "false") ? raw === "true" : raw;
  if (typeof value !== "boolean") return fail(path, "must be a boolean");
  return { ok: true, value };
};

const parseNode = (node: SchemaNode, value: unknown, path: string, options: ParseOptions): ParseResult<unknown> => {
  if (value === null) {
    return node.nullable === true ? { ok: true, value: null } : fail(path, "must not be null");
  }

  switch (node.type) {
    case "string":
      return parseString(node, value, path);
    case "integer":
      return parseInteger(node, value, path, options.coerce === true);
    case "number":
      return parseNumber(node, value, path, options.coerce === true);
    case "boolean":
      return parseBoolean(value, path, options.coerce === true);
    case "array": {
      if (!Array.isArray(value)) return fail(path, "must be an array");
      if (node.maxItems !== undefined && value.length > node.maxItems) {
        return fail(path, `must have at most ${node.maxItems} items`);
      }
      const items: unknown[] = [];
      const errors: FieldError[] = [];
      value.forEach((item, index) => {
        const result = parseNode(node.items, item, join(path, String(index)), options);
        if (result.ok) items.push(result.value);
        else errors.push(...result.errors);
      });
      return errors.length > 0 ? { ok: false, errors } : { ok: true, value: items };
    }
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) return fail(path, "must be an object");
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const errors: FieldError[] = [];

      // An open map: the keys belong to the caller, so every value is checked and no key
      // is ever "not recognised". Key shape is somebody else's rule — see `map`.
      if (!("properties" in node)) {
        if (node.maxProperties !== undefined && Object.keys(source).length > node.maxProperties) {
          return fail(path, `must have at most ${node.maxProperties} entries`);
        }
        for (const [key, child] of Object.entries(source)) {
          const result = parseNode(node.additionalProperties, child, join(path, key), options);
          if (result.ok) out[key] = result.value;
          else errors.push(...result.errors);
        }
        return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
      }

      for (const [key, child] of Object.entries(node.properties)) {
        const present = Object.hasOwn(source, key) && source[key] !== undefined;
        if (!present) {
          if (child.optional !== true) errors.push({ path: join(path, key), message: "is required" });
          continue;
        }
        const result = parseNode(child, source[key], join(path, key), options);
        if (result.ok) out[key] = result.value;
        else errors.push(...result.errors);
      }

      if (options.unknown === "reject") {
        for (const key of Object.keys(source)) {
          if (!Object.hasOwn(node.properties, key)) {
            errors.push({ path: join(path, key), message: "is not a recognised field" });
          }
        }
      }

      return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out };
    }
  }
};

export const parse = <T>(schema: Schema<T>, value: unknown, options: ParseOptions): ParseResult<T> =>
  parseNode(schema.node, value, "", options) as ParseResult<T>;

// ---------------------------------------------------------------------------
// OpenAPI
// ---------------------------------------------------------------------------

/** Loose on purpose: this is JSON on its way to a file, not a type anyone programs against. */
export type JsonSchema = Record<string, unknown>;

/**
 * OpenAPI 3.1, where `nullable` is spelled as a type union rather than the 3.0 keyword.
 * Generators built for 3.1 read `type: ["string", "null"]`; the old `nullable: true` is
 * silently ignored by them, which produces a client that thinks a field is never null.
 */
export const toJsonSchema = (node: SchemaNode): JsonSchema => {
  const base: JsonSchema = (() => {
    switch (node.type) {
      case "string":
        return defined({
          type: "string",
          format: node.format,
          minLength: node.minLength,
          maxLength: node.maxLength,
          pattern: node.pattern,
          enum: node.enum,
        });
      case "number":
      case "integer":
        return defined({ type: node.type, minimum: node.minimum, maximum: node.maximum });
      case "boolean":
        return { type: "boolean" };
      case "array":
        return defined({ type: "array", items: toJsonSchema(node.items), maxItems: node.maxItems });
      case "object": {
        if (!("properties" in node)) {
          return defined({
            type: "object",
            additionalProperties: toJsonSchema(node.additionalProperties),
            maxProperties: node.maxProperties,
          });
        }
        const required = Object.entries(node.properties)
          .filter(([, child]) => child.optional !== true)
          .map(([key]) => key);
        return {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(node.properties).map(([key, child]) => [key, toJsonSchema(child)]),
          ),
          required,
          additionalProperties: false,
        };
      }
    }
  })();

  if (node.nullable !== true) return base;
  return { ...base, type: [base["type"], "null"] };
};
