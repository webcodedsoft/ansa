// Places one outbound call, for testing the outbound path end to end.
//
// A script and not an HTTP endpoint, deliberately. An unauthenticated "dial this number"
// route sitting behind a public tunnel lets anyone who finds the URL make our carrier
// account ring any number on earth at our expense. When outbound does get an API it needs
// authentication, per-tenant rate limits, and the consent gate described in CLAUDE.md —
// none of which exist yet, and none of which should be skipped because a script was
// convenient.
//
//   TENANT_ID=... node tools/outbound/place-call.mjs +2348138178550
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

const provider = createTwilioTelephonyProvider({
  authToken: env.TWILIO_AUTH_TOKEN,
  verifySignatures: true,
  accountSid: env.TWILIO_ACCOUNT_SID,
});

const wsOrigin = env.PUBLIC_BASE_URL.replace(/^http/, "ws");
const tenantId = process.env.TENANT_ID;

const placed = await provider.placeCall({
  to,
  from: env.OUTBOUND_FROM ?? "+18148592625",
  mediaStreamUrl: `${wsOrigin}/telephony/media`,
  // Outbound already knows whose call this is; it travels out here rather than being
  // re-derived from caller ID on the way back in.
  ...(tenantId === undefined ? {} : { parameters: { tenantId } }),
});

// Queued is not answered. Nothing has rung yet.
console.log(JSON.stringify(placed, null, 2));
console.log("\nqueued, not answered — watch the API log for the media stream");
