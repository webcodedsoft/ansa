import { describe, expect, it } from "vitest";

import { fieldName, sentences, withoutPrefix } from "./problem-text";

/**
 * The words in the red box, which somebody has to act on.
 *
 * Written against a real screenshot. Adding a tool with empty fields produced this, in one
 * unbroken line:
 *
 *   body.http.1.name must be at least 3 characters. body.http.1.description must be at
 *   least 1 characters. body.http.1.url must be at least 1 characters. …
 *
 * Three faults in one message. The path is how the API points at a field and not how a
 * person refers to one; "1 characters" is wrong twice over and is the commonest message
 * there is, because `minLength: 1` is how every required field is written; and four
 * fragments run together read as one long fault rather than four short ones. The API fixed
 * the second — an empty box now says "is required" — and these cover the other two.
 */

describe("naming the field a refusal is about", () => {
  it("drops the part that says where in the request it was", () => {
    // Everything a form submits is the body. Saying so tells nobody anything.
    expect(fieldName("body.name")).toBe("Name");
    expect(fieldName("query.page")).toBe("Page");
    expect(fieldName("path.agentId")).toBe("Agent id");
  });

  it("counts array positions the way people do", () => {
    // `http.1` is the second tool. Showing the zero-based index sends somebody to the wrong
    // row, which is worse than showing no index at all.
    expect(fieldName("body.http.1.name")).toBe("Http #2 name");
    expect(fieldName("body.http.0.url")).toBe("Http #1 url");
  });

  it("spaces out the names the code uses", () => {
    expect(fieldName("body.ringSeconds")).toBe("Ring seconds");
    expect(fieldName("body.speech.fallback")).toBe("Speech fallback");
    expect(fieldName("body.escalation.toNumber")).toBe("Escalation to number");
  });

  it("leaves a plain name alone", () => {
    expect(fieldName("email")).toBe("Email");
  });
});

describe("putting several refusals together", () => {
  it("ends each one, so four faults read as four", () => {
    expect(sentences(["Name is required", "Url is required"])).toBe(
      "Name is required. Url is required.",
    );
  });

  it("does not double a full stop the message already has", () => {
    expect(sentences(["Name is required."])).toBe("Name is required.");
  });

  it("handles the single case without a trailing space", () => {
    expect(sentences(["Name is required"])).toBe("Name is required.");
  });
});

describe("the message from the screenshot", () => {
  it("reads as instructions rather than as a stack trace", () => {
    // The exact paths from that 422, with the API's corrected messages.
    const message = sentences(
      [
        ["body.http.1.name", "must be at least 3 characters"],
        ["body.http.1.description", "is required"],
        ["body.http.1.url", "is required"],
        ["body.http.1.speech.template", "is required"],
      ].map(([path, problem]) => `${fieldName(path ?? "")} ${problem ?? ""}`),
    );

    expect(message).toBe(
      "Http #2 name must be at least 3 characters. Http #2 description is required. " +
        "Http #2 url is required. Http #2 speech template is required.",
    );
    expect(message).not.toContain("body.");
    expect(message).not.toContain("1 characters");
  });
});

describe("a form editing one item of a collection", () => {
  it("drops the index the reader is already looking at", () => {
    // The screen is headed "Add a tool". Telling somebody about "Http #2" when there is one
    // tool in front of them sends them looking for a second one.
    expect(fieldName(withoutPrefix("body.http.1.name", "http.1"))).toBe("Name");
    expect(fieldName(withoutPrefix("body.http.1.speech.template", "http.1"))).toBe(
      "Speech template",
    );
  });

  it("keeps the index when the refusal is about a different item", () => {
    // A tool the operator is not editing failing validation is exactly when they need to be
    // told which one, so this must not be stripped.
    expect(fieldName(withoutPrefix("body.http.0.url", "http.1"))).toBe("Http #1 url");
  });

  it("leaves a path that shares no prefix alone", () => {
    expect(fieldName(withoutPrefix("body.egress.allowedHosts", "http.1"))).toBe(
      "Egress allowed hosts",
    );
  });
});
