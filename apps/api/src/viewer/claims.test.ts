import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ClaimSource, CorpusEntry } from "@ansa/db";
import { describe, expect, it } from "vitest";

import { buildClaim, renderClaim } from "./claims";

/**
 * A reviewed call, as a file `eval/verdict.py` will read (R9.2.4).
 *
 * The last describe block runs the real tool over the real output, because a "claim format"
 * that the scorer refuses to parse is not a format. Rule 0 holds either way: nothing here
 * imports Python and nothing in `eval/` imports this — the two meet at a file on disk,
 * which is the only contract between them.
 */

const entry = (over: Partial<CorpusEntry> = {}): CorpusEntry => ({
  transcriptId: "41",
  callId: "3f0e5e6a-0000-4000-8000-000000000001",
  carrierCallId: "CA-claim",
  offsetMs: 4_200,
  provider: "openai",
  confidence: 0.42,
  heard: "Chike",
  corrected: "Sikiru",
  correctedAt: new Date("2026-08-09T09:00:00Z"),
  ...over,
});

const source = (over: Partial<ClaimSource> = {}): ClaimSource => ({
  callId: "3f0e5e6a-0000-4000-8000-000000000001",
  carrierCallId: "CA-claim",
  configVersion: 4,
  listenConfig: {
    listenProvider: "openai",
    encoding: "mulaw",
    sampleRate: 8_000,
    model: "gpt-4o-transcribe",
    language: "en",
    turnDetection: "semantic_vad",
    eagerness: "auto",
  },
  entries: [entry()],
  ...over,
});

describe("what becomes ground truth", () => {
  it("takes the reviewer's text as the truth and the transcriber's as the trial", () => {
    const claim = buildClaim(source());
    const configuration = Object.values(claim.configurations)[0];

    expect(claim.expected[0]?.truth).toBe("Sikiru");
    expect(configuration?.["trials"]).toEqual(["Chike"]);
  });

  it("labels a bare name as a name and a read-out reference as an identifier", () => {
    const named = buildClaim(source({ entries: [entry({ corrected: "Sikiru" })] }));
    const read = buildClaim(
      source({ entries: [entry({ corrected: "P M 8 5 9 2 6 2 5", heard: "PM8592624" })] }),
    );

    expect(named.expected[0]?.kind).toBe("name");
    expect(read.expected[0]?.kind).toBe("identifier");
  });

  it("refuses to guess at a sentence, and says why in the file", () => {
    // The truth for a turn is not the truth for an item inside it, and nobody has marked
    // which span is the name. A prose turn labelled `identifier` canonicalises to gibberish
    // and produces a MISS that says nothing about the transcriber.
    const claim = buildClaim(
      source({ entries: [entry({ corrected: "Good afternoon, my name is Sikiru" })] }),
    );

    expect(claim.expected).toEqual([]);
    expect(claim.unlabelled[0]?.kind).toBe("prose");
    expect(claim.unlabelled[0]?.reason).toContain("nobody has marked");
  });

  it("does not read a capitalised sentence as a name", () => {
    const claim = buildClaim(source({ entries: [entry({ corrected: "My Name Is Sikiru" })] }));
    expect(claim.expected).toEqual([]);
  });

  it("names every item by its transcript, so two turns cannot collide", () => {
    const claim = buildClaim(
      source({
        entries: [
          entry({ transcriptId: "41", offsetMs: 1_000, corrected: "Sikiru" }),
          entry({ transcriptId: "42", offsetMs: 9_000, corrected: "Adebayo" }),
        ],
      }),
    );
    expect(claim.expected.map((i) => i.id)).toEqual(["t41@1000ms", "t42@9000ms"]);
  });
});

describe("the configuration a result is only comparable with", () => {
  it("reads the six required settings off the call's own configuration event", () => {
    const configuration = Object.values(buildClaim(source()).configurations)[0];

    expect(configuration).toMatchObject({
      provider: "openai",
      model: "gpt-4o-transcribe",
      encoding: "mulaw",
      sample_rate: 8_000,
      language: "en",
      endpointing: "semantic_vad/auto",
    });
  });

  it("renders Deepgram's endpointing from the thresholds it records", () => {
    const configuration = Object.values(
      buildClaim(
        source({
          listenConfig: {
            listenProvider: "deepgram",
            encoding: "mulaw",
            sampleRate: 8_000,
            model: "flux-general-en",
            eotThreshold: 0.8,
            eotTimeoutMs: 3_000,
            keyterms: 7,
          },
          entries: [entry({ provider: "deepgram" })],
        }),
      ).configurations,
    )[0];

    expect(configuration?.["endpointing"]).toBe("eot_threshold=0.8, eot_timeout_ms=3000");
    // The count, not the list: the list is the organization's configuration and is versioned
    // there. What a reader needs is whether a boost was in effect at all.
    expect(configuration?.["keyterms_sent"]).toBe(7);
  });

  it("leaves a setting that was never recorded null rather than inventing one", () => {
    const configuration = Object.values(
      buildClaim(source({ listenConfig: null })).configurations,
    )[0];

    expect(configuration?.["model"]).toBeNull();
    expect(configuration?.["language"]).toBeNull();
    expect(configuration?.["endpointing"]).toBeNull();
  });

  it("keeps two transcribers on the same audio apart", () => {
    // Composite runs two sessions on one call (R4.1.9). A trial filed against the wrong
    // vendor is worse than a missing one.
    const claim = buildClaim(
      source({
        entries: [
          entry({ provider: "openai", heard: "Chike", corrected: "Sikiru" }),
          entry({ transcriptId: "42", provider: "deepgram", heard: "Akiro", corrected: "Sikiru" }),
        ],
      }),
    );
    const labels = Object.keys(claim.configurations);

    expect(labels).toHaveLength(2);
    expect(claim.configurations[labels[0] ?? ""]?.["trials"]).toEqual(["Chike"]);
    expect(claim.configurations[labels[1] ?? ""]?.["trials"]).toEqual(["Akiro"]);
  });
});

/**
 * The tool is the contract. If it refuses to read what this writes, the format is wrong.
 *
 * Skipped where `python3` is not on the machine rather than failed — `eval/` is run by
 * hand and this repository's CI is not required to have an interpreter for it. The claim
 * being unreadable is a real failure; not having Python is not.
 */
const python = ((): string | null => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return "python3";
  } catch {
    return null;
  }
})();

describe.skipIf(python === null)("scored by eval/verdict.py itself", () => {
  const verdict = resolve(process.cwd(), "../../eval/verdict.py");

  const run = (claim: string): { code: number; out: string } => {
    const dir = mkdtempSync(join(tmpdir(), "ansa-claim-"));
    const path = join(dir, "claim.json");
    writeFileSync(path, claim, "utf8");
    try {
      return { code: 0, out: execFileSync("python3", [verdict, path], { encoding: "utf8" }) };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failure.status ?? -1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }
  };

  it("is read without complaint, and refuses a verdict at one trial", () => {
    // Exit 2 is the designed answer: one production call is one observation, and four
    // comparisons on this project were each decided from one run and reversed by the next.
    // Padding to three by repeating the same string would manufacture the agreement the
    // three-trial rule exists to detect.
    const { code, out } = run(renderClaim(source()));

    expect(out).toContain("Sikiru");
    expect(out).toContain("heard instead");
    expect(out).toContain("3 trials are required");
    expect(code).toBe(2);
  });

  it("reaches a MISS once the same configuration has three trials", () => {
    // What the workflow actually produces: three runs of the candidate over the audio,
    // scored against the truth this file supplied.
    const claim = buildClaim(source());
    const label = Object.keys(claim.configurations)[0] ?? "";
    const configuration = { ...claim.configurations[label], trials: ["Chike", "Chike", "Chike"] };
    const { code, out } = run(
      `${JSON.stringify({ ...claim, configurations: { [label]: configuration } }, null, 2)}\n`,
    );

    expect(out).toContain("MISS");
    expect(code).toBe(1);
  });

  it("refuses a configuration whose settings were never written down", () => {
    const { code, out } = run(renderClaim(source({ listenConfig: null })));

    expect(out).toContain("configuration not recorded");
    expect(code).toBe(2);
  });
});
