import { describe, expect, it } from "vitest";

import { recordingsToDelete, type RecordingOnDisk } from "./audio-retention";

const NOW = new Date("2026-08-08T00:00:00Z");
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

const recording = (callId: string, age: number): RecordingOnDisk => ({
  file: `${callId}.ulaw`,
  callId,
  modifiedAt: daysAgo(age),
});

/**
 * Deleting a caller's recorded voice is not something to learn the behaviour of in
 * production, which is why the policy is a pure function and these run without a disk.
 */
describe("what the retention sweep deletes", () => {
  it("deletes audio whose call is past its tenant's window", () => {
    const doomed = recordingsToDelete(
      [recording("CA-old", 40)],
      { expired: new Set(["CA-old"]), known: new Set(["CA-old"]) },
      daysAgo(30),
    );
    expect(doomed.map((r) => r.callId)).toEqual(["CA-old"]);
  });

  it("keeps audio belonging to a tenant who chose to keep it longer", () => {
    // The case a naive "older than the default" sweep gets wrong: 40 days old, but its
    // tenant configured 90, so the database did not report it as expired and it stays.
    const doomed = recordingsToDelete(
      [recording("CA-long", 40)],
      { expired: new Set(), known: new Set(["CA-long"]) },
      daysAgo(30),
    );
    expect(doomed).toHaveLength(0);
  });

  it("deletes audio that belongs to no call, on the strictest clock anyone set", () => {
    // Written before the tenant resolved, or the `calls` row never landed. Nobody's
    // policy covers it and it is still somebody's voice, so it does not live forever for
    // want of an owner.
    const doomed = recordingsToDelete(
      [recording("CA-orphan", 40)],
      { expired: new Set(), known: new Set() },
      daysAgo(30),
    );
    expect(doomed.map((r) => r.callId)).toEqual(["CA-orphan"]);
  });

  it("leaves a recent orphan alone, since a call in progress has no row yet", () => {
    const doomed = recordingsToDelete(
      [recording("CA-live", 0)],
      { expired: new Set(), known: new Set() },
      daysAgo(30),
    );
    expect(doomed).toHaveLength(0);
  });

  it("keeps today's audio, which is the whole reason recording is ever turned on", () => {
    const doomed = recordingsToDelete(
      [recording("CA-today", 0)],
      { expired: new Set(), known: new Set(["CA-today"]) },
      daysAgo(30),
    );
    expect(doomed).toHaveLength(0);
  });

  it("judges each recording on its own call rather than on the batch", () => {
    const doomed = recordingsToDelete(
      [recording("CA-a", 100), recording("CA-b", 1), recording("CA-c", 99)],
      { expired: new Set(["CA-a"]), known: new Set(["CA-a", "CA-b", "CA-c"]) },
      daysAgo(30),
    );
    expect(doomed.map((r) => r.callId)).toEqual(["CA-a"]);
  });
});
