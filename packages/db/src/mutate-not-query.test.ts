import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `update` and `delete` with a `returning` clause must go through `scope.mutate`.
 *
 * Not a style rule. TypeORM's Postgres driver hands back the rows for a `select` and
 * `[rows, affectedCount]` for an update or delete — so `rows.length === 0` on a `query` is
 * always false, and the handler above it concludes it changed something it did not touch.
 *
 * This is the third time that mistake has been made here. The adversarial API test caught
 * it once ("change a member of another organisation" answered 200 while changing nothing,
 * because RLS correctly matched zero rows and the check for zero rows could not see it), it
 * was reintroduced in `updateAgent` and `archiveAgent`, and again in `renameOrganization`.
 * Twice is a mistake; three times is a missing test.
 *
 * A source scan rather than a type: the two methods have the same signature on purpose —
 * `mutate` unwraps the pair — so nothing in the type system can tell them apart, and the
 * difference only shows in the SQL string.
 */

/* From the working directory rather than from `import.meta`, which this package's module
   target does not allow. Vitest runs with the package root as cwd. If that ever stops being
   true the scan finds no files, so the count is asserted below — a guard that silently
   inspects nothing is worse than none, because it reports success forever. */
const SOURCE = join(process.cwd(), "src");

const sqlLiteralsPassedToQuery = (contents: string): readonly string[] => {
  const found: string[] = [];
  // `scope.query<Row>(` or `scope.query(`, then a template literal. Deliberately naive: it
  // is looking for a shape, and anything it cannot parse is not what this is guarding.
  const call = /scope\s*\.\s*query\s*(?:<[^>]*>)?\s*\(\s*`([^`]*)`/gs;
  for (const match of contents.matchAll(call)) found.push(match[1] ?? "");
  return found;
};

const offends = (sql: string): boolean => {
  const flat = sql.toLowerCase();
  return /\b(update|delete)\b/.test(flat) && flat.includes("returning");
};

describe("update and delete with returning", () => {
  it("never go through scope.query", () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const name of readdirSync(SOURCE)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      scanned += 1;
      const contents = readFileSync(join(SOURCE, name), "utf8");
      for (const sql of sqlLiteralsPassedToQuery(contents)) {
        if (offends(sql)) offenders.push(`${name}: ${sql.trim().split("\n")[0]?.trim()}`);
      }
    }

    /* If this fails, the fix is `scope.mutate` and not an exception here. The failing call
       reports success for rows it did not change, which on this codebase means telling
       somebody an edit landed when RLS or a `deleted_at` filter matched nothing. */
    expect(offenders).toEqual([]);
    // Proof the scan ran. Without this the test passes when it reads nothing at all.
    expect(scanned).toBeGreaterThan(5);
  });

  it("catches the shape it is meant to catch", () => {
    // The guard is a regex over source. A guard that cannot fail is not one, so this proves
    // it recognises the mistake rather than merely returning an empty list.
    const bad = 'const rows = await scope.query<{ id: string }>(`update agents set x = 1 returning id`);';
    expect(sqlLiteralsPassedToQuery(bad).some(offends)).toBe(true);

    const fine = 'const rows = await scope.query<Row>(`select id from agents where id = $1`);';
    expect(sqlLiteralsPassedToQuery(fine).some(offends)).toBe(false);

    const mutating = 'await scope.mutate<{ id: string }>(`update agents set x = 1 returning id`);';
    expect(sqlLiteralsPassedToQuery(mutating).some(offends)).toBe(false);
  });
});
