import { describe, expect, it } from "vitest";

import { parseCurl } from "./curl-import";

/**
 * Reading somebody else's curl command.
 *
 * The cases are the ones real commands actually contain — line continuations, mixed quoting,
 * flags nobody cares about — rather than a tidy grammar. A parser for this only earns its place
 * if it survives what a vendor's documentation page hands you.
 *
 * The credential cases matter most. Everything else here is convenience and a person can see
 * the result on screen; a key copied into a stored tool is a key inside a configuration
 * document, and nobody sees that until it leaks.
 */

describe("importing a curl command", () => {
  it("reads the URL, the method and the headers", () => {
    const { draft } = parseCurl(
      `curl -X POST 'https://api.example.test/v1/policies' -H 'Accept: application/json' -H 'X-Tenant: kano'`,
    );

    expect(draft.url).toBe("https://api.example.test/v1/policies");
    expect(draft.method).toBe("POST");
    expect(draft.headers).toEqual([
      { name: "Accept", value: "application/json" },
      { name: "X-Tenant", value: "kano" },
    ]);
  });

  it("survives the line continuations every documented command is wrapped in", () => {
    const { draft } = parseCurl(`curl https://api.example.test/lookup \\
      -H "Accept: application/json" \\
      --data '{"reference":"AB1234"}'`);

    expect(draft.url).toBe("https://api.example.test/lookup");
    expect(draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
  });

  it("treats a body as a POST that sends its arguments in one", () => {
    /* Both halves matter. Defaulting to GET would send a body nobody reads, and leaving `send`
       on "query" would silently drop every argument the tool is given. */
    const { draft } = parseCurl(`curl https://api.example.test/claims -d '{"id":1}'`);
    expect(draft.method).toBe("POST");
    expect(draft.send).toBe("body");
  });

  it("leaves a plain command sending its arguments in the query string", () => {
    const { draft } = parseCurl("curl https://api.example.test/status");
    expect(draft.method).toBe("GET");
    expect(draft.send).toBe("query");
  });

  it("drops an Authorization header rather than storing it, and says so", () => {
    const { draft, unsupported } = parseCurl(
      `curl https://api.example.test/me -H 'Authorization: Bearer sk-not-a-real-key' -H 'Accept: application/json'`,
    );

    expect(draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
    expect(JSON.stringify(draft)).not.toContain("sk-not-a-real-key");
    expect(unsupported.join(" ")).toContain("stored credential");
  });

  it("drops the other names vendors use for the same thing", () => {
    const { draft } = parseCurl(
      `curl https://api.example.test/me -H 'X-API-Key: sk-not-a-real-key' -H 'api-key: sk-not-a-real-key'`,
    );
    expect(draft.headers).toEqual([]);
    expect(JSON.stringify(draft)).not.toContain("sk-not-a-real-key");
  });

  it("drops basic auth given as -u", () => {
    const { draft, unsupported } = parseCurl(
      "curl -u operator:sk-not-a-real-key https://api.example.test/me",
    );
    expect(JSON.stringify(draft)).not.toContain("sk-not-a-real-key");
    expect(draft.url).toBe("https://api.example.test/me");
    expect(unsupported.join(" ")).toContain("stored credential");
  });

  it("does not mistake a flag's value for the URL", () => {
    /* `-o out.json` would otherwise leave the draft pointing at a filename, which fails the
       host check with a message about nothing. */
    const { draft } = parseCurl("curl -s -o out.json https://api.example.test/report");
    expect(draft.url).toBe("https://api.example.test/report");
  });

  it("guesses no risk tier", () => {
    /* A POST is not necessarily a write, and the tier decides whether a caller hears a value
       read back before anything happens. Wrong is worse than absent. */
    const { draft } = parseCurl("curl -X POST https://api.example.test/refunds -d '{}'");
    expect(draft.riskTier).toBe("read");
  });

  it("reports a flag it did not understand instead of ignoring it", () => {
    const { unsupported } = parseCurl(
      "curl --proxy http://127.0.0.1:8080 https://api.example.test",
    );
    expect(unsupported.join(" ")).toContain("--proxy");
  });

  it("says when a URL still holds a shell substitution", () => {
    const { unsupported } = parseCurl("curl https://api.example.test/$(whoami)");
    expect(unsupported.join(" ")).toContain("shell substitution");
  });

  it("comes back blank rather than throwing on something that is not a command", () => {
    // Somebody pastes a sentence. The form has to survive it.
    const { draft } = parseCurl("please call the policy endpoint");
    expect(draft.headers).toEqual([]);
    expect(draft.method).toBe("GET");
  });
});
