import { asOrganizationId } from "@ansa/shared";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordCallStarted, recordTranscripts } from "./call-log";
import { loadCallDetail } from "./call-page";
import { createDataSource } from "./data-source";
import { withOrganization } from "./organization-scope";
import { loadDotEnv } from "./test-env";

loadDotEnv();

const url = process.env["DIRECT_URL"];

/**
 * Both halves of a conversation, from the write to the read (0076).
 *
 * The nearest thing to a phone call that a test can be. Everything downstream — the chat on
 * the call page, a summary grounded in what was said, a reviewer correcting the half the model
 * produced — depends on an agent line being written with a speaker and coming back with one,
 * and until this existed nothing checked either end. `loadCallDetail` had no test at all.
 *
 * Its own id range — `e8e8…` — per `test-organization-ids.test.ts`.
 */
const ORG = asOrganizationId("e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e8");

let ds: DataSource;

describe.skipIf(url === undefined)("reading a call back", () => {
  beforeAll(async () => {
    ds = await createDataSource({ url: url ?? "", poolSize: 2 }).initialize();
    await withOrganization(ds, ORG, async (s) => {
      await s.query(
        "insert into organizations (id, name) values ($1, 'Conversation Org') on conflict do nothing",
        [ORG],
      );
    });
  }, 60_000);

  afterAll(async () => {
    if (ds === undefined) return;
    await withOrganization(ds, ORG, async (s) => {
      await s.query("delete from organizations where id = $1", [ORG]);
    });
    await ds.destroy();
  });

  it("keeps who said what, in the order it was said", async () => {
    const callId = await recordCallStarted(ds, {
      organizationId: ORG,
      carrierCallId: "CA-conversation-1",
      direction: "inbound",
      dialled: "+18148592625",
      caller: "+2348030000009",
      agentId: null,
      configVersion: 1,
    });
    expect(callId).not.toBeNull();

    /* Written the way a call writes them: one flush carrying both sides, out of order,
       because the recorder batches and the two arrive from different places. */
    await recordTranscripts(ds, ORG, String(callId), [
      {
        speaker: "caller",
        text: "I am calling about the flat on Adeola Odeku.",
        confidence: 0.91,
        offsetMs: 4200,
        provider: "flux",
      },
      {
        speaker: "agent",
        text: "Good day, Oakhaven Properties. How can I help?",
        confidence: null,
        offsetMs: 300,
        provider: "eleven-voice-id",
      },
    ]);

    const detail = await withOrganization(ds, ORG, (s) => loadCallDetail(s, String(callId)));
    expect(detail).not.toBeNull();

    const lines = detail?.transcripts ?? [];
    expect(lines.map((t) => t.speaker)).toEqual(["agent", "caller"]);
    expect(lines.map((t) => t.text)).toEqual([
      "Good day, Oakhaven Properties. How can I help?",
      "I am calling about the flat on Adeola Odeku.",
    ]);

    // The agent's own words carry no confidence: we know exactly what we said.
    expect(lines[0]?.confidence).toBeNull();
    expect(lines[0]?.provider).toBe("eleven-voice-id");
    // The caller's does, because it is a guess at somebody else's speech.
    expect(lines[1]?.confidence).toBeCloseTo(0.91, 2);
  });

  it("refuses a line that does not say who spoke", async () => {
    /* The column's default was dropped after the backfill precisely so this fails loudly. A
       silent default would have filed every future agent line as the caller, which is the
       state the whole slice existed to end. */
    const callId = await recordCallStarted(ds, {
      organizationId: ORG,
      carrierCallId: "CA-conversation-2",
      direction: "inbound",
      dialled: "+18148592625",
      caller: "+2348030000009",
      agentId: null,
      configVersion: 1,
    });

    await expect(
      withOrganization(ds, ORG, (s) =>
        s.query(
          `insert into transcripts (organization_id, call_id, kind, text, confidence, offset_ms, provider)
           values ($1, $2, 'final', 'who said this?', 0.9, 10, 'flux')`,
          [ORG, String(callId)],
        ),
      ),
    ).rejects.toThrow();
  });
});
