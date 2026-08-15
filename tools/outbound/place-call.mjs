// Places one outbound call, for testing the outbound path end to end.
//
// A script and not an HTTP endpoint, deliberately. An unauthenticated "dial this number"
// route sitting behind a public tunnel lets anyone who finds the URL make our carrier
// account ring any number on earth at our expense. When outbound does get an API it needs
// authentication, per-organization rate limits, and the consent gate described in CLAUDE.md —
// none of which exist yet, and none of which should be skipped because a script was
// convenient.
//
//   ORGANIZATION_ID=... node tools/outbound/place-call.mjs +2348138178550
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url).pathname;
const require = createRequire(`${root}apps/api/package.json`);

const env = Object.fromEntries(
  readFileSync(`${root}.env`, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

const to = process.argv[2];
if (!to?.startsWith("+")) throw new Error("Pass the destination in E.164, e.g. +2348138178550");

const { createTwilioTelephonyProvider } = require(`${root}packages/providers/telephony/dist/index.js`);
const { createDataSource } = require(`${root}packages/db/dist/index.js`);
const { placeOutboundCall, ConsentError } = require(`${root}apps/api/dist/outbound/place.js`);
const { createLogger } = require(`${root}packages/shared/dist/index.js`);

const provider = createTwilioTelephonyProvider({
  authToken: env.TWILIO_AUTH_TOKEN,
  verifySignatures: true,
  accountSid: env.TWILIO_ACCOUNT_SID,
});

const wsOrigin = env.PUBLIC_BASE_URL.replace(/^http/, "ws");
const organizationId = process.env.ORGANIZATION_ID;
if (organizationId === undefined) throw new Error("ORGANIZATION_ID is required: consent is per organization");

const dataSource = await createDataSource({ url: env.DATABASE_URL }).initialize();

try {
  // Through the gate, not around it. Going straight to provider.placeCall would work and
  // would be the whole problem: one door, so the check cannot be on one path and not
  // another.
  const placed = await placeOutboundCall(
    { dataSource, telephony: provider, log: createLogger({ component: "outbound" }) },
    {
      organizationId,
      to,
      from: env.OUTBOUND_FROM ?? "+18148592625",
      mediaStreamUrl: `${wsOrigin}/telephony/media`,
      amdCallbackUrl: `${env.PUBLIC_BASE_URL}/telephony/amd`,
      statusCallbackUrl: `${env.PUBLIC_BASE_URL}/telephony/status`,
    },
  );

  // Queued is not answered. Nothing has rung yet.
  console.log(JSON.stringify(placed, null, 2));
  console.log("\nqueued, not answered — watch the API log for the media stream");
} catch (error) {
  if (error instanceof ConsentError) {
    console.error(`refused: ${error.message}`);
    console.error("\nRecord consent first — see tools/outbound/grant-consent.mjs");
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  await dataSource.destroy();
}
