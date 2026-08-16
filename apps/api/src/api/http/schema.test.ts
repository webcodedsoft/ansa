import { describe, expect, it } from "vitest";

import { choice, flag, integer, list, map, nullable, object, optional, parse, text, toJsonSchema } from "./schema";

const INPUT = { unknown: "reject" } as const;
const OUTPUT = { unknown: "strip" } as const;

describe("parsing input", () => {
  const body = object({
    email: text({ pattern: /@/ }),
    role: choice(["owner", "member"]),
    seats: optional(integer({ minimum: 1, maximum: 10 })),
    active: flag(),
    tags: list(text({ maxLength: 4 })),
    note: nullable(text()),
  });

  it("accepts a well-formed value", () => {
    const result = parse(body, {
      email: "a@b.co",
      role: "owner",
      active: true,
      tags: ["one"],
      note: null,
    }, INPUT);
    expect(result).toEqual({
      ok: true,
      value: { email: "a@b.co", role: "owner", active: true, tags: ["one"], note: null },
    });
  });

  it("reports every field that failed, not just the first", () => {
    const result = parse(body, { email: "nope", role: "admin", active: "yes", tags: ["toolong"], note: null }, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path).sort()).toEqual(["active", "email", "role", "tags.0"]);
  });

  it("names a missing required field", () => {
    const result = parse(body, { role: "owner", active: true, tags: [], note: null }, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ path: "email", message: "is required" }]);
  });

  /** A misspelled field is a caller's mistake, and silently ignoring it hides it. */
  it("rejects a field the schema does not name", () => {
    const result = parse(body, { email: "a@b.co", role: "owner", active: true, tags: [], note: null, admin: true }, INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([{ path: "admin", message: "is not a recognised field" }]);
  });

  it("refuses null where the schema does not allow it", () => {
    const result = parse(object({ name: text() }), { name: null }, INPUT);
    expect(result.ok).toBe(false);
  });
});

describe("coercion", () => {
  const query = object({ limit: optional(integer({ minimum: 1 })), all: optional(flag()) });

  it("turns query strings into the types the schema declares", () => {
    expect(parse(query, { limit: "25", all: "true" }, { ...INPUT, coerce: true })).toEqual({
      ok: true,
      value: { limit: 25, all: true },
    });
  });

  /**
   * A JSON body that sends "25" for an integer is a client bug. Accepting it hides the bug
   * until the day something sends "25 " instead.
   */
  it("does not coerce a JSON body", () => {
    expect(parse(query, { limit: "25" }, INPUT).ok).toBe(false);
  });

  it("does not accept a decimal as an integer", () => {
    expect(parse(query, { limit: "2.5" }, { ...INPUT, coerce: true }).ok).toBe(false);
  });
});

describe("projecting output", () => {
  const member = object({ id: text(), role: choice(["owner", "member"]) });

  /**
   * The reason the response schema is applied at all: it is an allowlist, so a column
   * added to a table cannot leak through an endpoint nobody updated.
   */
  it("drops anything the schema does not name", () => {
    const result = parse(member, { id: "1", role: "owner", passwordHash: "scrypt$…" }, OUTPUT);
    expect(result).toEqual({ ok: true, value: { id: "1", role: "owner" } });
  });

  it("fails when the value is missing something the schema promises", () => {
    expect(parse(member, { id: "1" }, OUTPUT).ok).toBe(false);
  });
});

describe("the OpenAPI projection", () => {
  it("marks optional properties as not required", () => {
    const schema = toJsonSchema(object({ a: text(), b: optional(text()) }).node);
    expect(schema["required"]).toEqual(["a"]);
    expect(schema["additionalProperties"]).toBe(false);
  });

  /**
   * OpenAPI 3.1 spells nullability as a type union. The 3.0 `nullable: true` keyword is
   * silently ignored by 3.1 generators, which produces a client that thinks a field is
   * never null.
   */
  it("spells a nullable field as a type union", () => {
    expect(toJsonSchema(nullable(text()).node)["type"]).toEqual(["string", "null"]);
  });

  it("carries the constraints the validator enforces", () => {
    const schema = toJsonSchema(text({ minLength: 2, maxLength: 5, pattern: /^a/ }).node);
    expect(schema).toMatchObject({ minLength: 2, maxLength: 5, pattern: "^a" });
  });
});

describe("an open map", () => {
  const headers = object({ headers: map(text({ maxLength: 12 }), { maxProperties: 2 }) });
  const read = (value: unknown) => parse(headers, value, { unknown: "reject" });

  it("accepts keys nobody declared", () => {
    // The whole point: header names belong to somebody else's API, not to this schema.
    expect(read({ headers: { "X-Tenant": "acme", "X-Region": "lagos" } })).toMatchObject({
      ok: true,
      value: { headers: { "X-Tenant": "acme", "X-Region": "lagos" } },
    });
  });

  it("never calls a key unrecognised, even under unknown: reject", () => {
    // A declared object would refuse every one of these. An open map must not, or the
    // rejection rule for the document around it would make the map unusable.
    expect(read({ headers: { anything: "at all" } }).ok).toBe(true);
  });

  it("checks every value against the value schema", () => {
    expect(read({ headers: { "X-Tenant": "far too long to fit" } })).toMatchObject({ ok: false });
  });

  it("names the offending key in the error path, not just the map", () => {
    const result = read({ headers: { "X-Ok": "fine", "X-Bad": "far too long to fit" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.path).toContain("X-Bad");
  });

  it("bounds how many there can be", () => {
    expect(read({ headers: { a: "1", b: "2", c: "3" } })).toMatchObject({ ok: false });
  });

  it("takes an empty map", () => {
    expect(read({ headers: {} })).toMatchObject({ ok: true, value: { headers: {} } });
  });

  it("still refuses a non-object", () => {
    expect(read({ headers: ["X-Tenant", "acme"] })).toMatchObject({ ok: false });
  });
});

/**
 * The wording a refusal reaches an operator in.
 *
 * `minLength: 1` is how every required text field in this API is written, so its message is
 * the one people meet most — and it read "must be at least 1 characters", which is wrong
 * about the grammar and about the problem. An empty box is a missing answer, not a value of
 * insufficient length, and the console prints these straight onto the screen.
 */
describe("what a refusal says", () => {
  const refusal = (schema: Parameters<typeof parse>[0], value: unknown): string => {
    const result = parse(schema, value, INPUT);
    if (result.ok) throw new Error("expected this value to be refused");
    return result.errors[0]?.message ?? "";
  };

  it("calls an empty required field missing, not too short", () => {
    expect(refusal(object({ name: text({ minLength: 1 }) }), { name: "" })).toBe("is required");
  });

  it("counts characters in the singular when there is one", () => {
    // Reachable through `maxLength: 1`, and the same helper serves both bounds.
    expect(refusal(object({ initial: text({ maxLength: 1 }) }), { initial: "ab" })).toBe(
      "must be at most 1 character",
    );
  });

  it("keeps the plural for every other count", () => {
    expect(refusal(object({ name: text({ minLength: 3 }) }), { name: "ab" })).toBe(
      "must be at least 3 characters",
    );
    expect(refusal(object({ name: text({ maxLength: 4 }) }), { name: "abcde" })).toBe(
      "must be at most 4 characters",
    );
  });
});
