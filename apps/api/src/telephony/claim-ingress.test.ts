import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { createDataSource, setClaimToken, withOrganization, type Db } from "@ansa/db";
import { asCallId, asOrganizationId } from "@ansa/shared";
import type { Logger } from "@ansa/shared";
import type { InboundCall, TelephonyProvider } from "@ansa/telephony";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AppConfig } from "../config/env";
import { UNKNOWN_AGENT, type AgentRegistry } from "../tenancy/agent-registry";
import type { MediaGateway } from "./media.gateway";
import { VoiceController } from "./voice.controller";

/**
 * Importing a number, through the code that actually runs when the call arrives.
 *
 * The claim is only worth anything if it happens on the real ingress path, so this drives
 * `VoiceController.answerForToken` itself against a real database rather than calling the SQL
 * function directly — `number-claim.test.ts` already covers the function. What is under test
 * here is the wiring: that the route reaches the claim, that the call is still answered
 * afterwards, and that a bad token changes nothing while still returning TwiML.
 *
 * The collaborators around the database are fakes because none of them is the subject. There
 * is no carrier and no media socket in a test; there is a real `organization_numbers` row or
 * there is not.
 */

/** The app takes configuration from the real environment; only tests read the file. */
const loadEnv = (): void => {
  try {
    for (const line of readFileSync(resolvePath(process.cwd(), "../../.env"), "utf8").split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed === "" || trimmed.startsWith("#") || eq === -1) continue;
      const key = trimmed.slice(0, eq);
      process.env[key] ??= trimmed.slice(eq + 1);
    }
  } catch {
    // CI supplies them directly.
  }
};

loadEnv();

const appUrl = process.env["DATABASE_URL"];
const ownerUrl = process.env["MIGRATION_DIRECT_URL"];

/** Unique to this file, for the reason `caller-history.test.ts` records. */
const ORGANIZATION = asOrganizationId("c6c6c6c6-c6c6-4c6c-8c6c-c6c6c6c6c6c6");
const TOKEN = "c6".repeat(32);
const NUMBER = "+2349660000001";
const UNCLAIMED = "+2349660000002";

const silent = (): Logger => {
  const make = (): Logger => ({
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => make(),
  });
  return make();
};

/**
 * Enough of a carrier to answer "which call is this" and "what shall I say".
 *
 * `verifyWebhook` returns false throughout, deliberately: the tokened route must never consult
 * it. A number brought from another provider is signed with that provider's secret and not
 * ours, so a route that checked would reject every call it exists to serve — and a fake that
 * said true would hide that.
 */
const carrier = (call: InboundCall): TelephonyProvider =>
  ({
    verifyWebhook: () => false,
    parseInboundCall: () => call,
    renderAnswer: () => ({ contentType: "text/xml", body: "<Response/>" }),
  }) as unknown as TelephonyProvider;

const registry = {
  resolve: async () => UNKNOWN_AGENT,
  cached: () => UNKNOWN_AGENT,
} as unknown as AgentRegistry;

const media = {
  warmForOrganization: () => undefined,
  warmCallerHistory: () => undefined,
} as unknown as MediaGateway;

const config = { publicBaseUrl: "https://claim.test" } as AppConfig;

let db: Db;
let owner: Db | null = null;

const controllerFor = (dialled: string): VoiceController =>
  new VoiceController(
    carrier({ callId: asCallId(`CA-${randomUUID()}`), dialled, caller: "+2348000000001" }),
    config,
    silent(),
    registry,
    db,
    media,
  );

const heldBy = async (number: string): Promise<string | null> => {
  const rows = (await owner?.query(
    "select organization_id from organization_numbers where number = $1",
    [number],
  )) as { organization_id: string }[];
  return rows[0]?.organization_id ?? null;
};

const answered = { setHeader: () => undefined };

describe.skipIf(appUrl === undefined || ownerUrl === undefined)(
  "a call arriving on an organisation's own carrier",
  () => {
    beforeAll(async () => {
      db = await createDataSource({ url: appUrl ?? "", poolSize: 2 }).initialize();
      owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
      await owner.query("insert into organizations (id, name) values ($1, $2)", [
        ORGANIZATION,
        "Claim Ingress",
      ]);
      await withOrganization(db, ORGANIZATION, (scope) => setClaimToken(scope, TOKEN));
    }, 60_000);

    afterAll(async () => {
      for (const number of [NUMBER, UNCLAIMED]) {
        await owner?.query("delete from organization_numbers where number = $1", [number]);
      }
      await owner?.query("delete from organizations where id = $1", [ORGANIZATION]);
      await db?.destroy();
      await owner?.destroy();
    });

    it("attaches the number and still answers the call", async () => {
      expect(await heldBy(NUMBER)).toBeNull();

      const body = await controllerFor(NUMBER).answerForToken(TOKEN, {}, answered);

      // The caller hears something. An import that answered with a 500 would prove control and
      // drop the very call that proved it.
      expect(body).toContain("<Response");
      expect(await heldBy(NUMBER)).toBe(ORGANIZATION);
    });

    it("changes nothing for a token nobody holds, and answers anyway", async () => {
      /* Answering identically is the point rather than a convenience: a route that behaved
         differently for a real token than a made-up one would be an oracle for guessing them. */
      const body = await controllerFor(UNCLAIMED).answerForToken("ff".repeat(32), {}, answered);
      expect(body).toContain("<Response");
      expect(await heldBy(UNCLAIMED)).toBeNull();
    });

    it("answers a second call on the same number without a second row", async () => {
      await controllerFor(NUMBER).answerForToken(TOKEN, {}, answered);
      const rows = (await owner?.query(
        "select count(*)::int as held from organization_numbers where number = $1",
        [NUMBER],
      )) as { held: number }[];
      expect(rows[0]?.held).toBe(1);
    });
  },
);
