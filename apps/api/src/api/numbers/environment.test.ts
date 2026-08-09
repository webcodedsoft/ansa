import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectedVoiceWebhookUrl,
  loadNumbersEnvironment,
  VOICE_WEBHOOK_PATH,
} from "./environment";

/**
 * Reading the environment must never throw, because everything downstream of it is a health
 * check and a health check that 500s on a missing variable has failed at its one job.
 */

describe("the readiness environment", () => {
  it("reads nothing from an empty environment and does not complain", () => {
    expect(loadNumbersEnvironment({})).toEqual({
      publicBaseUrl: null,
      carrier: null,
      voice: null,
      platformVoiceId: null,
      credentialKey: "absent",
      platformHandoff: false,
    });
  });

  /** A trailing slash would produce a double slash in a URL the carrier signs exactly. */
  it("strips a trailing slash from the public address", () => {
    const url = expectedVoiceWebhookUrl(
      loadNumbersEnvironment({ PUBLIC_BASE_URL: "https://ansa.example/" }),
    );
    expect(url).toBe(`https://ansa.example${VOICE_WEBHOOK_PATH}`);
  });

  it("has no URL to state when the process does not know its own address", () => {
    expect(expectedVoiceWebhookUrl(loadNumbersEnvironment({}))).toBeNull();
  });

  /**
   * Absent and malformed fail differently and are reported differently: absent drops every
   * credentialed tool silently on every call, malformed stops the call process booting.
   */
  it("tells a missing vault key apart from one of the wrong length", () => {
    expect(loadNumbersEnvironment({}).credentialKey).toBe("absent");
    expect(loadNumbersEnvironment({ TOOL_CREDENTIAL_KEY: "c2hvcnQ=" }).credentialKey).toBe(
      "malformed",
    );
    expect(
      loadNumbersEnvironment({ TOOL_CREDENTIAL_KEY: Buffer.alloc(32).toString("base64") })
        .credentialKey,
    ).toBe("present");
  });

  /** Half a carrier credential produces a 401 that would read as "could not check". */
  it("takes carrier credentials as a pair or not at all", () => {
    expect(loadNumbersEnvironment({ TWILIO_ACCOUNT_SID: "AC0" }).carrier).toBeNull();
    expect(loadNumbersEnvironment({ TWILIO_AUTH_TOKEN: "t" }).carrier).toBeNull();
    expect(
      loadNumbersEnvironment({ TWILIO_ACCOUNT_SID: "AC0", TWILIO_AUTH_TOKEN: "t" }).carrier,
    ).toEqual({ accountSid: "AC0", authToken: "t" });
  });

  it("requires both handoff numbers, in E.164, before claiming a fallback exists", () => {
    expect(loadNumbersEnvironment({ HANDOFF_TO_NUMBER: "+2348000000000" }).platformHandoff).toBe(
      false,
    );
    expect(
      loadNumbersEnvironment({
        HANDOFF_TO_NUMBER: "08000000000",
        HANDOFF_FROM_NUMBER: "+2348000000001",
      }).platformHandoff,
    ).toBe(false);
    expect(
      loadNumbersEnvironment({
        HANDOFF_TO_NUMBER: "+2348000000000",
        HANDOFF_FROM_NUMBER: "+2348000000001",
      }).platformHandoff,
    ).toBe(true);
  });
});

/**
 * The one duplicated string in this area, and the test that stops it drifting.
 *
 * `VOICE_WEBHOOK_PATH` is what an operator is told to configure at the carrier and what the
 * carrier's record is compared against. Importing the controller to derive it would drag the
 * whole call path — carrier SDK, listen providers, media gateway — into a dashboard request,
 * so the source is read instead. Same trade `routes.test.ts` makes next door.
 */
describe("the voice webhook path", () => {
  it("is the path the carrier webhook controller actually serves", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "telephony", "voice.controller.ts"),
      "utf8",
    );
    const controller = /@Controller\("([^"]+)"\)/.exec(source)?.[1];
    const route = /@Post\("(voice)"\)/.exec(source)?.[1];
    expect(controller, "voice.controller.ts no longer declares a literal @Controller path").toBeDefined();
    expect(route, "voice.controller.ts no longer declares @Post(\"voice\")").toBeDefined();
    expect(VOICE_WEBHOOK_PATH).toBe(`/${controller}/${route}`);
  });
});
