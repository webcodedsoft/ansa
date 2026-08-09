import { describe, expect, it } from "vitest";

import {
  choice,
  flag,
  integer,
  list,
  nullable,
  object,
  optional,
  parse,
  text,
  toJsonSchema,
} from "./schema";

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
