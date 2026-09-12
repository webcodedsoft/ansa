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

  /**
   * The shape Postman's "copy as curl" and a Windows clipboard produce: a space or a carriage
   * return between the backslash and the line break. Invisible in the box, and it used to
   * empty the URL field while the headers filled — the first thing a person tried, and it
   * looked as though the paste had done nothing.
   */
  it("survives a trailing space or a carriage return after the continuation backslash", () => {
    const withSpace = parseCurl(
      `curl --location 'https://api.example.test/quotation?regNo=FST901EE' \\ \n--header 'Content-Type: application/json'`,
    );
    expect(withSpace.draft.url).toBe("https://api.example.test/quotation?regNo=FST901EE");
    expect(withSpace.draft.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);

    const windows = parseCurl(
      `curl --location 'https://api.example.test/quotation?regNo=FST901EE' \\\r\n--header 'Accept: application/json'`,
    );
    expect(windows.draft.url).toBe("https://api.example.test/quotation?regNo=FST901EE");
    expect(windows.draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
  });

  it("drops the shell's own terminator from the end of a pasted command", () => {
    const { draft } = parseCurl(`curl https://api.example.test/lookup --header 'Content-Type: application/json';`);
    expect(draft.headers).toEqual([{ name: "Content-Type", value: "application/json" }]);
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

  /**
   * The shapes real pastes come in. Each of these is the same request as the first test, and
   * a person who pastes it should see the same filled form, not a reason it did not work.
   */
  describe("in the formats people actually paste", () => {
    const URL = "https://api.example.test/quotation?regNo=FST901EE";

    it("reads Postman's Windows cmd export, with caret continuations and double quotes", () => {
      const { draft } = parseCurl(
        `curl --location "${URL}" ^\n--header "Accept: application/json" ^\n--header "X-Tenant: kano"`,
      );
      expect(draft.url).toBe(URL);
      expect(draft.headers).toEqual([
        { name: "Accept", value: "application/json" },
        { name: "X-Tenant", value: "kano" },
      ]);
    });

    it("reads Postman's PowerShell export, with curl.exe and backtick continuations", () => {
      const { draft } = parseCurl(`curl.exe --location '${URL}' \`\n--header 'Accept: application/json'`);
      expect(draft.url).toBe(URL);
      expect(draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
    });

    it("reads a browser's Copy as cURL, keeping the API's headers and leaving the browser's", () => {
      const { draft, unsupported } = parseCurl(`curl '${URL}' \\
  -H 'accept: application/json' \\
  -H 'accept-language: en-GB,en;q=0.9' \\
  -H 'cookie: session=sk-not-a-real-key' \\
  -H 'priority: u=1, i' \\
  -H 'sec-ch-ua: "Chromium";v="130"' \\
  -H 'sec-fetch-mode: cors' \\
  -H 'user-agent: Mozilla/5.0' \\
  -H 'x-tenant: kano' \\
  --compressed`);
      expect(draft.url).toBe(URL);
      expect(draft.headers).toEqual([
        { name: "accept", value: "application/json" },
        { name: "x-tenant", value: "kano" },
      ]);
      expect(JSON.stringify(draft)).not.toContain("sk-not-a-real-key");
      expect(unsupported.join(" ")).toContain("stored credential");
      expect(unsupported.join(" ")).toContain("5 headers a browser adds");
    });

    it("reads the $'…' quoting a browser uses for a body with a newline in it", () => {
      const { draft } = parseCurl(
        `curl '${URL}' -H 'content-type: application/json' --data-raw $'{"a":"it\\'s"}'`,
      );
      expect(draft.method).toBe("POST");
      expect(draft.send).toBe("body");
      expect(draft.headers).toEqual([{ name: "content-type", value: "application/json" }]);
    });

    it("spreads run-together short flags and splits a glued value", () => {
      const { draft, unsupported } = parseCurl(`curl -sSL -XPOST -H'Accept: application/json' ${URL}`);
      expect(draft.url).toBe(URL);
      expect(draft.method).toBe("POST");
      expect(draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
      expect(unsupported).toEqual([]);
    });

    it("reads long flags written with an equals sign", () => {
      const { draft } = parseCurl(`curl --request=PUT --header="Accept: application/json" --url=${URL}`);
      expect(draft.url).toBe(URL);
      expect(draft.method).toBe("PUT");
      expect(draft.headers).toEqual([{ name: "Accept", value: "application/json" }]);
    });

    it("ignores the prompt, the code fence and the pipe it was copied with", () => {
      const { draft, unsupported } = parseCurl("```bash\n$ curl -s " + URL + " | jq .\n```");
      expect(draft.url).toBe(URL);
      expect(unsupported).toEqual([]);
    });

    it("moves -G data into the query string, as curl does", () => {
      const { draft } = parseCurl(`curl -G https://api.example.test/search -d 'q=lagos' --data-urlencode 'limit=5'`);
      expect(draft.url).toBe("https://api.example.test/search?q=lagos&limit=5");
      expect(draft.method).toBe("GET");
      expect(draft.send).toBe("query");
    });

    it("takes --json as a JSON body with the headers it implies", () => {
      const { draft } = parseCurl(`curl https://api.example.test/claims --json '{"id":1}'`);
      expect(draft.method).toBe("POST");
      expect(draft.send).toBe("body");
      expect(draft.headers).toEqual([
        { name: "Content-Type", value: "application/json" },
        { name: "Accept", value: "application/json" },
      ]);
    });

    it("drops a cookie string and a bearer flag as the credentials they are", () => {
      const { draft, unsupported } = parseCurl(
        `curl -b 'session=sk-not-a-real-key' --oauth2-bearer sk-not-a-real-key ${URL}`,
      );
      expect(JSON.stringify(draft)).not.toContain("sk-not-a-real-key");
      expect(draft.url).toBe(URL);
      expect(unsupported.join(" ")).toContain("stored credential");
    });

    it("keeps the URL when an unknown flag's value comes after it", () => {
      const { draft, unsupported } = parseCurl(`curl ${URL} --proxy 127.0.0.1:8080`);
      expect(draft.url).toBe(URL);
      expect(unsupported.join(" ")).toContain("--proxy");
    });

    it("says what a Postman variable in the URL is, and leaves it there", () => {
      const { draft, unsupported } = parseCurl("curl '{{baseUrl}}/quotation'");
      expect(draft.url).toBe("{{baseUrl}}/quotation");
      expect(unsupported.join(" ")).toContain("Postman variable");
    });

    it("names a PowerShell paste for what it is instead of filling nothing silently", () => {
      const { draft, unsupported } = parseCurl(`Invoke-WebRequest -Uri "${URL}" -Headers @{"Accept"="application/json"}`);
      expect(draft.url).toBe("");
      expect(unsupported.join(" ")).toContain("PowerShell");
    });

    it("does not let a header carrying a HEAD or OPTIONS request through as GET silently", () => {
      const { unsupported } = parseCurl(`curl -X OPTIONS ${URL}`);
      expect(unsupported.join(" ")).toContain("OPTIONS");
    });
  });

  it("comes back blank rather than throwing on something that is not a command", () => {
    // Somebody pastes a sentence. The form has to survive it.
    const { draft } = parseCurl("please call the policy endpoint");
    expect(draft.headers).toEqual([]);
    expect(draft.method).toBe("GET");
  });
});
