import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { API_CONTROLLERS } from "../api.module";
import { renderClient, tsType } from "./client";
import { buildDocument, SPEC_PATH, specInfo } from "./document";

const document = buildDocument(API_CONTROLLERS, specInfo());

const operation = (path: string, method: string): Record<string, unknown> => {
  const paths = document["paths"] as Record<string, Record<string, Record<string, unknown>>>;
  const found = paths[path]?.[method];
  if (found === undefined) throw new Error(`no ${method} ${path} in the document`);
  return found;
};

describe("the OpenAPI document", () => {
  /**
   * The point of generating rather than writing it. If someone edits `openapi.json` by
   * hand, or changes an endpoint and does not regenerate, this is where it stops.
   */
  it("matches the file committed to the repository", () => {
    const committed = readFileSync(resolve(process.cwd(), SPEC_PATH), "utf8");
    expect(committed).toBe(`${JSON.stringify(document, null, 2)}\n`);
  });

  it("publishes the capability each operation enforces", () => {
    expect(operation("/api/v1/members/{userId}", "patch")["x-ansa-capability"]).toBe("members:write");
    expect(operation("/api/v1/auth/sessions", "post")["x-ansa-capability"]).toBe("public");
  });

  it("exempts public operations from the bearer requirement and nothing else", () => {
    expect(operation("/api/v1/auth/sessions", "post")["security"]).toEqual([]);
    expect(operation("/api/v1/calls", "get")["security"]).toBeUndefined();
    expect(document["security"]).toEqual([{ session: [] }]);
  });

  /**
   * Derived from what the endpoint declares, not listed by hand — so an operation cannot
   * document a 403 it can never return, or omit one it can.
   */
  it("documents the failures each operation can actually produce", () => {
    const list = Object.keys(operation("/api/v1/calls", "get")["responses"] as object).sort();
    expect(list).toEqual(["200", "401", "403", "422", "500", "503"]);

    const signIn = Object.keys(operation("/api/v1/auth/sessions", "post")["responses"] as object).sort();
    expect(signIn).toEqual(["201", "422", "429", "500", "503"]);
  });

  it("turns Nest's path parameters into OpenAPI's", () => {
    const parameters = operation("/api/v1/members/{userId}", "patch")["parameters"];
    expect(parameters).toMatchObject([{ name: "userId", in: "path", required: true }]);
  });

  it("is stable, so regenerating produces no diff", () => {
    expect(JSON.stringify(buildDocument(API_CONTROLLERS, specInfo()))).toBe(JSON.stringify(document));
  });
});

describe("the generated client", () => {
  const source = renderClient(document);

  it("has a method for every operation, grouped by area", () => {
    expect(source).toContain("members: {");
    expect(source).toContain("setRole: (input:");
    expect(source).toContain("accept: (input:");
    expect(source).toContain("createAnsaClient");
    // Every failure arrives as one type, carrying the problem document the API returned.
    expect(source).toContain("AnsaApiError");
  });

  it("interpolates path parameters safely", () => {
    expect(source).toContain("${encodeURIComponent(input.path.userId)}");
  });

  it("returns void for an endpoint that answers 204", () => {
    expect(source).toMatch(/remove: \(input:[\s\S]*?send<void>\(options, "DELETE"/);
  });

  it("renders nullable fields as unions, not as optional", () => {
    expect(tsType({ type: ["string", "null"] })).toBe("string | null");
    expect(tsType({ enum: ["a", "b"], type: "string" })).toBe(`"a" | "b"`);
  });

  /**
   * `readonly "a" | "b"[]` is a syntax error, and the generator emitted one for
   * `GET /auth/me`'s capability list before this existed.
   */
  it("parenthesises array items, so an array of a union parses", () => {
    expect(tsType({ type: "array", items: { type: "integer" } })).toBe("readonly (number)[]");
    expect(tsType({ type: "array", items: { enum: ["a", "b"], type: "string" } })).toBe(
      `readonly ("a" | "b")[]`,
    );
  });

  it("carries the summary through as documentation", () => {
    expect(source).toContain("List this organisation's calls, newest first");
  });
});
