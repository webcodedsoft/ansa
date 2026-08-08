import { describe, expect, it } from "vitest";

import { redactArgs } from "./redact";

describe("redaction", () => {
  it("removes anything named like a credential, at any depth", () => {
    expect(
      redactArgs({
        policyNumber: "AXA4421",
        apiKey: "sk-live-1",
        auth: { bearer: "abc", scheme: "basic" },
        nested: [{ password: "hunter2" }],
      }),
    ).toEqual({
      policyNumber: "AXA4421",
      apiKey: "[redacted]",
      auth: "[redacted]",
      nested: [{ password: "[redacted]" }],
    });
  });

  it("keeps a log line readable when a tool is handed a wall of text", () => {
    const long = redactArgs({ note: "x".repeat(500) }).note;
    expect(String(long)).toHaveLength(200 + "…[500]".length);
  });

  it("leaves ordinary arguments alone, because a redacted log explains nothing", () => {
    expect(redactArgs({ amount: 45000, active: true, holder: null })).toEqual({
      amount: 45000,
      active: true,
      holder: null,
    });
  });
});
