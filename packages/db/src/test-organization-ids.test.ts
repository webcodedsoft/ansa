import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * No two test files may claim the same organisation.
 *
 * These files share one database and run in parallel, so an id used twice is not a tidiness
 * problem: both files insert it, one loses on `tenants_pkey`, and whichever finishes first
 * deletes the organisation the other is still using. The result is a suite that passes file
 * by file and fails as a whole — which is the worst shape a test failure can take, because
 * the natural response is to re-run the one file and conclude it is fine.
 *
 * It has happened twice. `call-captures.test.ts` records the first, where it took a range
 * `organization-config.test.ts` already owned. The second was `drafts.test.ts` and
 * `call-content-retention.test.ts` both holding `c0c0…` and `c1c1…`, which cost 22 failures.
 * Both times the guard was a comment listing the ranges in use, and both times the comment
 * was out of date by the time somebody read it.
 *
 * So the registry is executable. It reads what the files actually declare rather than what a
 * header says they declare, and a collision fails here — named, with both files — instead of
 * as a duplicate key three minutes into a full run.
 */

/* From the working directory rather than from `import.meta`, which this package's module
   target does not allow — the same reason and the same shape as `mutate-not-query.test.ts`,
   which scans this directory too. Vitest runs with the package root as cwd; if that stops
   being true the scan finds nothing, which the second test below refuses to let pass. */
const here = join(process.cwd(), "src");

/** `asOrganizationId("…")`, which is how every one of these files names its organisations. */
const DECLARATION = /asOrganizationId\(\s*"([0-9a-fA-F-]{36})"/g;

const declarationsByFile = (): ReadonlyMap<string, readonly string[]> => {
  const found = new Map<string, readonly string[]>();
  for (const name of readdirSync(here)) {
    if (!name.endsWith(".test.ts") || name === "test-organization-ids.test.ts") continue;
    const source = readFileSync(join(here, name), "utf8");
    const ids = [...source.matchAll(DECLARATION)].map((match) => match[1] ?? "");
    if (ids.length > 0) found.set(name, [...new Set(ids)]);
  }
  return found;
};

describe("organisation ids across the test suite", () => {
  it("gives every file its own, so parallel runs cannot collide", () => {
    const owners = new Map<string, string[]>();
    for (const [file, ids] of declarationsByFile()) {
      for (const id of ids) owners.set(id, [...(owners.get(id) ?? []), file]);
    }

    const shared = [...owners.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([id, files]) => `${id} is claimed by ${files.join(" and ")}`);

    // Named rather than counted: the fix is to move one of them, and that needs both names.
    expect(shared).toEqual([]);
  });

  it("finds the declarations at all, so the guard cannot pass by reading nothing", () => {
    /* Without this the regex could stop matching — a rename of `asOrganizationId`, a change
       of quoting — and the check above would report no collisions forever while checking
       nothing at all. */
    const files = declarationsByFile();
    expect(files.size).toBeGreaterThan(8);
  });
});
