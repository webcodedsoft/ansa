import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A call reads what is published. Never what somebody is still editing.
 *
 * The database side of this is held in `packages/db/src/drafts.test.ts`, which asserts that no
 * `app.*` function except the three managing drafts mentions the table — so the SQL a call runs
 * cannot see one. This is the other half: the TypeScript above that SQL must not fetch a draft
 * itself and merge it into what the call is given.
 *
 * That is a real thing somebody could do without noticing it was wrong. `CallSettings` exists
 * precisely because the gateway once read an organisation's voice correctly and then passed
 * the platform's, and the fix was to make "everything about a call that depends on the
 * organisation" one structure. Adding a draft read to that structure would look like
 * completing it, and would put unpublished text on a phone line.
 *
 * A source scan rather than a type, for the same reason `mutate-not-query.test.ts` is one:
 * nothing in the type system distinguishes a draft read from a live one — they return the same
 * shape, which is the point of the shape — so the difference only shows in the import.
 */

/**
 * Everything that runs while a call is up, or decides what a call will be given.
 *
 * `tenancy` is the entry worth explaining: it holds `agent-registry.ts` and `call-settings.ts`,
 * which are not "the call" but are where a call's configuration is assembled. A draft reaching
 * a caller would almost certainly arrive through there.
 */
const CALL_PATH = ["telephony", "orchestrator", "tenancy", "outbound", "conversation"];

/**
 * The draft API, and the table itself.
 *
 * The table name is in the list because the helpers are not the only way to reach it. Most of
 * this codebase reaches the database through `app.*` functions, but `scope.query` takes raw
 * SQL and a `join agent_config_drafts` inside the call path would be invisible to a scan that
 * only knew the function names.
 */
const DRAFT_READERS = [
  "loadAgentDraft",
  "saveAgentDraft",
  "discardAgentDraft",
  "liveAgentId",
  "agent_config_drafts",
  /* The graph a conversation is drawn as has a draft of its own, and it is exactly as
     dangerous to read on a call as any other draft — more so, because it decides the shape
     of the call and not just its wording. A half-wired canvas with an edge going nowhere
     is a call that stalls in silence.

     `loadPublishedFlow` and `loadFlowAtVersion` are deliberately absent. Those are published
     reads and the call path is meant to use one of them. */
  "loadDraftFlow",
  "stageDraftFlow",
];

/* From the working directory rather than `import.meta`, matching the db package's scan.
   Vitest runs with the package root as cwd; if that stops being true the scan finds nothing,
   so the file count is asserted below. A guard that silently inspects nothing reports success
   forever. */
const SOURCE = join(process.cwd(), "src");

const sourceFilesUnder = (directory: string): readonly string[] => {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      // Tests are excluded deliberately: one may legitimately save a draft to prove a call
      // ignores it, which is the opposite of the mistake this looks for.
      if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
    }
  };
  walk(join(SOURCE, directory));
  return out;
};

describe("the call path", () => {
  it("never reads unpublished configuration", () => {
    const scanned = CALL_PATH.flatMap((directory) => sourceFilesUnder(directory));
    expect(scanned.length, "the scan found no files, so it is proving nothing").toBeGreaterThan(
      20,
    );

    const offenders = scanned.filter((path) => {
      const contents = readFileSync(path, "utf8");
      return DRAFT_READERS.some((name) => new RegExp(`\\b${name}\\b`).test(contents));
    });

    expect(
      offenders,
      `these run on a call and reference the draft API: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
