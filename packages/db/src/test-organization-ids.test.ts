import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * It has now happened three times. `call-captures.test.ts` records the first, where it took a
 * range `organization-config.test.ts` already owned. The second was `drafts.test.ts` and
 * `call-content-retention.test.ts` both holding `c0c0…` and `c1c1…`, which cost 22 failures.
 * The third was this guard's own fault: it scanned `@ansa/db` only, and `c8c8…` was claimed by
 * `call-content-retention.test.ts` here and by `sign-in.test.ts` in the API — two packages,
 * one database, and a guard looking at half of it. Turborepo runs the two suites at once, so
 * it failed only in a full run.
 *
 * So the registry is executable and it reads both halves. It reads what the files actually
 * declare rather than what a header says they declare, and a collision fails here — named,
 * with both files — instead of as a duplicate key three minutes into a full run.
 *
 * **Sharing an id is not automatically a bug, and this is the distinction that makes the
 * guard usable.** Several files deliberately share a fixture organisation and insert it with
 * `on conflict do nothing`; whichever runs first creates it, the rest find it there, and
 * nothing fails. What cannot be shared is an id inserted *bare* — that is the statement that
 * throws on the second writer, and it is what `sign-in.test.ts` did. A guard that failed on
 * every shared id would report six problems where there is one, and a guard reporting five
 * false alarms is a guard people learn to skip.
 */

/* From the working directory rather than from `import.meta`, which this package's module
   target does not allow — the same reason and the same shape as `mutate-not-query.test.ts`.
   Vitest runs with the package root as cwd, so the repo root is two levels up. If either of
   those stops being true the scan finds nothing, which the last test below refuses to allow. */
const ROOT = join(process.cwd(), "..", "..");
const SCANNED = [join(ROOT, "packages", "db", "src"), join(ROOT, "apps", "api", "src")];

/**
 * The two ways a test file names an organisation it is about to insert.
 *
 * `asOrganizationId("…")` is how this package does it. The API has no branded type at hand in
 * a test, so it writes a bare const — and that difference is exactly what let `c8c8…` be
 * claimed twice. Matching only the first shape is how a guard reports success while reading
 * half the suite.
 *
 * Deliberately not "every UUID in the file": these tests are full of call ids, agent ids and
 * number ids, and two files may share those freely — they are scoped to an organisation, which
 * is the whole point of the isolation model.
 */
const DECLARATIONS = [
  /asOrganizationId\(\s*"([0-9a-fA-F-]{36})"/g,
  /\b(?:const|let)\s+\w*(?:ORGANIZATION|ORGANISATION|TENANT|Organization|Organisation|Tenant)\w*\s*=\s*"([0-9a-fA-F-]{36})"/g,
];

const testFilesUnder = (directory: string): readonly string[] => {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".test.ts") && entry !== "test-organization-ids.test.ts") out.push(path);
    }
  };
  walk(directory);
  return out;
};

/**
 * Whether a file creates organisations in the way that cannot survive a second writer.
 *
 * `insert into organizations` with no `on conflict` throws on `tenants_pkey`. With one, the
 * second writer finds the row already there and carries on, which is why a shared fixture
 * organisation is a legitimate thing to have. Read per file rather than per statement: a file
 * with even one bare insert is a file whose ids must be its own.
 */
const insertsExclusively = (source: string): boolean =>
  [...source.matchAll(/insert\s+into\s+organizations\b[\s\S]{0,200}/g)].some(
    (match) => !/on\s+conflict/i.test(match[0]),
  );

interface Claim {
  readonly ids: readonly string[];
  /** True when this file's inserts would throw rather than yield to an existing row. */
  readonly exclusive: boolean;
}

/** Keyed by a path relative to the repo, because two packages both have a `calls.test.ts`. */
const declarationsByFile = (): ReadonlyMap<string, Claim> => {
  const found = new Map<string, Claim>();
  for (const directory of SCANNED) {
    for (const path of testFilesUnder(directory)) {
      const source = readFileSync(path, "utf8");
      const ids = DECLARATIONS.flatMap((pattern) =>
        [...source.matchAll(pattern)].map((match) => match[1]?.toLowerCase() ?? ""),
      );
      if (ids.length > 0) {
        found.set(path.slice(ROOT.length + 1), {
          ids: [...new Set(ids)],
          exclusive: insertsExclusively(source),
        });
      }
    }
  }
  return found;
};

describe("organisation ids across the test suite", () => {
  it("keeps every bare-insert organisation to one file, so parallel runs cannot collide", () => {
    const owners = new Map<string, string[]>();
    const exclusive = new Set<string>();
    for (const [file, claim] of declarationsByFile()) {
      for (const id of claim.ids) {
        owners.set(id, [...(owners.get(id) ?? []), file]);
        if (claim.exclusive) exclusive.add(id);
      }
    }

    const collisions = [...owners.entries()]
      .filter(([id, files]) => files.length > 1 && exclusive.has(id))
      .map(
        ([id, files]) =>
          `${id} is claimed by ${files.join(" and ")}, and at least one inserts it bare`,
      );

    // Named rather than counted: the fix is to move one of them, and that needs both names.
    expect(collisions).toEqual([]);
  });

  it("reads both packages, so a collision cannot hide in the half it does not scan", () => {
    /* The third collision was invisible because the scan stopped at this package. Asserting
       the count per root is what makes that specific regression fail here rather than in a
       full run twenty minutes later. */
    const files = [...declarationsByFile().keys()];

    expect(files.filter((file) => file.startsWith("packages/db/")).length).toBeGreaterThan(8);
    expect(files.filter((file) => file.startsWith("apps/api/")).length).toBeGreaterThan(0);
  });
});
