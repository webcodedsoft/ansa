import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { asOrganizationId } from "@ansa/shared";
import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  callbackUrls,
  createOrigination,
  readCarrierEnvironment,
} from "./origination";

/**
 * The two things about a test call that can be established without a carrier and a phone.
 *
 * The first is arithmetic on strings — which environment variables are needed and what the
 * carrier is told to call back on — and it is here because a wrong callback URL produces a
 * call that rings, is answered, and sits in silence, which is the most expensive way to
 * find out.
 *
 * The second is structural, and it is the one worth having: **this area does not know how
 * to place a call.** `provider.placeCall` is not reachable from the dashboard, because the
 * only thing here that originates anything hands the request to `outbound/place.ts` — the
 * door with the consent gate in it. That is asserted below by reading the source, in the
 * same spirit as the test that keeps `adapter.execute` to one call site: a second path is
 * not a type error and not a logic error, it is only ever visible as a second call site.
 *
 * What is *not* here is the consent verdict itself. It is decided by `outbound/consent.ts`,
 * which is pure and exhaustively tested next to itself, and running it from this side would
 * need a database — which would be testing the seam rather than the rule.
 */

const owner = asOrganizationId("00000000-0000-4000-8000-000000000000");

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};

const CONFIGURED: Readonly<Record<string, string>> = {
  PUBLIC_BASE_URL: "https://tunnel.example.invalid",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "not-a-real-token",
};

describe("the carrier environment", () => {
  it("names what is missing rather than reporting a half-configuration", () => {
    const reading = readCarrierEnvironment({});
    expect(reading.environment).toBeNull();
    expect(reading.missing).toEqual([
      "PUBLIC_BASE_URL",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
    ]);
  });

  /**
   * An inbound-only deployment has no account SID, which is a working configuration —
   * `AppConfig` has the field as optional for that reason. It must be reported as "cannot
   * place calls" and never as two thirds of a carrier.
   */
  it("is null when only the account is missing", () => {
    const { PUBLIC_BASE_URL, TWILIO_AUTH_TOKEN } = CONFIGURED;
    const reading = readCarrierEnvironment({ PUBLIC_BASE_URL, TWILIO_AUTH_TOKEN });
    expect(reading.environment).toBeNull();
    expect(reading.missing).toEqual(["TWILIO_ACCOUNT_SID"]);
  });

  it("treats a variable set to whitespace as unset", () => {
    expect(readCarrierEnvironment({ ...CONFIGURED, TWILIO_AUTH_TOKEN: "   " }).missing).toEqual([
      "TWILIO_AUTH_TOKEN",
    ]);
  });

  /** A double slash in the URL the carrier signs fails every webhook it sends back. */
  it("drops a trailing slash from the origin", () => {
    const reading = readCarrierEnvironment({ ...CONFIGURED, PUBLIC_BASE_URL: "https://x.invalid//" });
    expect(reading.environment?.publicBaseUrl).toBe("https://x.invalid");
  });
});

describe("where the carrier calls back to", () => {
  it("opens the media stream over websockets and the webhooks over https", () => {
    expect(callbackUrls("https://tunnel.example.invalid")).toEqual({
      mediaStreamUrl: "wss://tunnel.example.invalid/telephony/media",
      statusCallbackUrl: "https://tunnel.example.invalid/telephony/status",
      amdCallbackUrl: "https://tunnel.example.invalid/telephony/amd",
    });
  });

  /** The paths come from `telephony/tokens.ts`; these are the paths the process serves. */
  it("uses the paths this process actually listens on", () => {
    const urls = callbackUrls("http://localhost.invalid");
    expect(urls.mediaStreamUrl.startsWith("ws://")).toBe(true);
    expect(new URL(urls.statusCallbackUrl).pathname).toBe("/telephony/status");
  });
});

describe("a deployment that cannot place calls", () => {
  it("refuses with the variables named, rather than failing at boot", async () => {
    const origination = createOrigination({ dataSource: null, log: silent, env: {} });
    await expect(
      origination.place({ owner, to: "+10000000000", from: "+10000000001" }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  /**
   * A carrier that is configured and a database that is not is 503 and not a consent
   * refusal. `placeOutboundCall` would refuse it — correctly, since it cannot check consent
   * — and the organization would read "we may not call this number", which is a different and
   * false statement about their own records.
   */
  it("does not report a missing database as a consent problem", async () => {
    const origination = createOrigination({ dataSource: null, log: silent, env: CONFIGURED });
    await expect(
      origination.place({ owner, to: "+10000000000", from: "+10000000001" }),
    ).rejects.toThrow(/without a database/);
  });
});

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });

describe("the dashboard's route to the carrier", () => {
  /**
   * One door. A handler that reached for the provider directly would work, and would be
   * exactly the failure the gate exists to prevent: the check on one path and not the other,
   * with the button on the second one.
   */
  it("never calls the carrier's own placeCall", () => {
    const offenders = sourceFiles(join(__dirname, "..")).filter((file) =>
      /\bplaceCall\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("has exactly one file in the dashboard that originates a call at all", () => {
    const callers = sourceFiles(join(__dirname, "..")).filter((file) =>
      /\bplaceOutboundCall\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(callers.map((file) => file.slice(join(__dirname, "..").length + 1))).toEqual([
      join("testcall", "origination.ts"),
    ]);
  });
});
