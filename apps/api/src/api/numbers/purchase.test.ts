import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { createDataSource, type Db } from "@ansa/db";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiModule } from "../api.module";
import { hashPassword } from "../auth/password";

/**
 * Buying a number, end to end, against a carrier that is not real.
 *
 * The real proof — a purchase in the platform's Twilio account — costs money every month
 * and needs an account that is active, and neither is a thing a test should depend on. So
 * this stands up a small HTTP server that answers like Twilio's REST API, points the API at
 * it through `TWILIO_API_BASE_URL`, and walks the whole path: what is for sale, buy one,
 * see it attached and priced, release it, see it gone — and that every step wrote to the
 * audit log and to the carrier in the right order.
 */

const loadEnv = (): void => {
  try {
    for (const line of readFileSync(resolve(process.cwd(), "../../.env"), "utf8").split("\n")) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (trimmed === "" || trimmed.startsWith("#") || eq === -1) continue;
      process.env[trimmed.slice(0, eq)] ??= trimmed.slice(eq + 1);
    }
  } catch {
    // CI supplies them directly.
  }
};

loadEnv();

const ownerUrl = process.env["MIGRATION_DIRECT_URL"];
const appUrl = process.env["DATABASE_URL"];

const FOR_SALE = "+15559990001";
const SID = "PNfake0000000000000000000000000001";

/** What the fake carrier saw, in order. */
const carrierSaw: { method: string; path: string; body: string }[] = [];

const fakeCarrier = (): Server =>
  createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const path = request.url ?? "";
      carrierSaw.push({ method: request.method ?? "", path, body });
      const answer = (status: number, json: unknown): void => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      if (path.includes("/AvailablePhoneNumbers.json")) {
        return answer(200, { countries: [{ country_code: "US", country: "United States" }, { country_code: "GB", country: "United Kingdom" }] });
      }
      if (path.includes("/AvailablePhoneNumbers/US/Local.json")) {
        return answer(200, {
          available_phone_numbers: [
            { phone_number: FOR_SALE, iso_country: "US", locality: "Erie" },
            { phone_number: "+15559990002", iso_country: "US", locality: "Erie" },
          ],
        });
      }
      if (path.includes("/v1/PhoneNumbers/Countries/US")) {
        return answer(200, { price_unit: "USD", phone_number_prices: [{ number_type: "local", current_price: "1.15" }] });
      }
      if (path.endsWith("/IncomingPhoneNumbers.json") && request.method === "POST") {
        return answer(201, { sid: SID, phone_number: FOR_SALE, voice_url: new URLSearchParams(body).get("VoiceUrl") });
      }
      if (path.includes(`/IncomingPhoneNumbers/${SID}.json`) && request.method === "DELETE") {
        response.writeHead(204);
        return response.end();
      }
      return answer(404, { message: "the fake carrier has no such route" });
    });
  });

let owner: Db;
let app: INestApplication;
let carrier: Server;
let baseUrl: string;
let token: string;
const organizationId = randomUUID();
const userId = randomUUID();

const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

describe.skipIf(ownerUrl === undefined || appUrl === undefined)("buying and releasing a number", () => {
  beforeAll(async () => {
    carrier = fakeCarrier();
    await new Promise<void>((done) => carrier.listen(0, "127.0.0.1", done));
    const port = (carrier.address() as AddressInfo).port;
    process.env["TWILIO_ACCOUNT_SID"] = "ACfake00000000000000000000000000000";
    process.env["TWILIO_AUTH_TOKEN"] = "fake-token";
    process.env["TWILIO_API_BASE_URL"] = `http://127.0.0.1:${port}`;
    process.env["TWILIO_PRICING_BASE_URL"] = `http://127.0.0.1:${port}`;
    process.env["PUBLIC_BASE_URL"] = "https://purchase.test";

    owner = await createDataSource({ url: ownerUrl ?? "", poolSize: 2 }).initialize();
    const email = `purchase-${organizationId}@invalid.test`;
    const password = `${randomUUID()}-${randomUUID()}`;
    await owner.query("delete from organization_numbers where number = $1", [FOR_SALE]);
    await owner.query("insert into organizations (id, name) values ($1, $2)", [organizationId, "Purchase endpoints"]);
    await owner.query("insert into users (id, email, password_hash, display_name) values ($1, $2, $3, $4)", [
      userId,
      email,
      await hashPassword(password),
      "Buyer",
    ]);
    await owner.query("insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [organizationId, userId]);

    app = await NestFactory.create(ApiModule, { logger: false });
    await app.listen(0);
    baseUrl = await app.getUrl();
    const signIn = await fetch(`${baseUrl}/api/v1/auth/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, organisationId: organizationId }),
    });
    token = String(((await signIn.json()) as Record<string, unknown>)["token"]);
  });

  afterAll(async () => {
    await app?.close();
    await new Promise<void>((done) => carrier?.close(() => done()));
    await owner?.query("delete from organization_numbers where number = $1", [FOR_SALE]);
    await owner?.query("delete from organizations where id = $1", [organizationId]);
    await owner?.query("delete from users where id = $1", [userId]);
    await owner?.destroy();
    for (const key of ["TWILIO_API_BASE_URL", "TWILIO_PRICING_BASE_URL"]) delete process.env[key];
  });

  it("offers what the carrier sells, and says Nigeria is not among them", async () => {
    const reply = await call("GET", "/api/v1/numbers/countries");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body["nigeria"]).toBe(false);
    expect(reply.body["items"]).toEqual([
      { code: "GB", name: "United Kingdom" },
      { code: "US", name: "United States" },
    ]);
  });

  it("lists numbers for sale with the country's monthly price", async () => {
    const reply = await call("GET", "/api/v1/numbers/available?country=US");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    expect(reply.body["items"]).toEqual([
      { number: FOR_SALE, country: "US", locality: "Erie", monthlyPrice: "1.15", currency: "USD" },
      { number: "+15559990002", country: "US", locality: "Erie", monthlyPrice: "1.15", currency: "USD" },
    ]);
  });

  it("buys a number pointed at this deployment, attaches it and prices it", async () => {
    const reply = await call("POST", "/api/v1/numbers", { number: FOR_SALE, country: "US" });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    const items = reply.body["items"] as Record<string, unknown>[];
    expect(items.find((one) => one["number"] === FOR_SALE)).toMatchObject({
      managedBy: "platform",
      country: "US",
      monthlyPrice: "1.15",
      answeredBy: null,
    });

    const purchase = carrierSaw.find((seen) => seen.method === "POST" && seen.path.endsWith("/IncomingPhoneNumbers.json"));
    expect(purchase, "the carrier was asked to sell").toBeDefined();
    const form = new URLSearchParams(purchase?.body ?? "");
    expect(form.get("PhoneNumber")).toBe(FOR_SALE);
    expect(form.get("VoiceUrl")).toBe("https://purchase.test/telephony/voice");
    expect(form.get("VoiceMethod")).toBe("POST");

    const rows = (await owner.query(
      "select managed_by, carrier_sid, country, monthly_price from organization_numbers where number = $1",
      [FOR_SALE],
    )) as Record<string, unknown>[];
    expect(rows[0]).toEqual({ managed_by: "platform", carrier_sid: SID, country: "US", monthly_price: "1.15" });

    const audit = (await owner.query(
      "select action, actor_name, subject_label from audit_events where organization_id = $1 and action = 'number_bought'",
      [organizationId],
    )) as Record<string, unknown>[];
    expect(audit).toEqual([{ action: "number_bought", actor_name: "Buyer", subject_label: FOR_SALE }]);
  });

  it("releases it here and at the carrier, in that order, and refuses a second release", async () => {
    const before = carrierSaw.length;
    const reply = await call("DELETE", `/api/v1/numbers/${encodeURIComponent(FOR_SALE)}`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(204);

    const rows = (await owner.query("select 1 from organization_numbers where number = $1", [FOR_SALE])) as unknown[];
    expect(rows).toHaveLength(0);
    const release = carrierSaw.slice(before).find((seen) => seen.method === "DELETE");
    expect(release?.path).toContain(`/IncomingPhoneNumbers/${SID}.json`);

    const again = await call("DELETE", `/api/v1/numbers/${encodeURIComponent(FOR_SALE)}`);
    expect(again.status).toBe(404);

    const audit = (await owner.query(
      "select action from audit_events where organization_id = $1 and action like 'number_%' order by occurred_at",
      [organizationId],
    )) as Record<string, unknown>[];
    expect(audit.map((row) => row["action"])).toEqual(["number_bought", "number_released"]);
  });
});
