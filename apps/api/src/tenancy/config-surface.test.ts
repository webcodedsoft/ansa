import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderConfigurationSurface } from "./config-surface";

/**
 * The anti-drift mechanism for `docs/TENANT_CONFIGURATION.md`.
 *
 * A document describing what a tenant can and cannot configure is only worth having if it
 * cannot survive the commit that changes the answer. So it is generated from the modules
 * that enforce the answer, checked in so a reader does not have to run anything, and this
 * test fails the moment the two disagree.
 *
 * To rewrite it: `WRITE_DOCS=1 pnpm --filter @ansa/api test`.
 */
/**
 * Walked up from the working directory rather than resolved from `import.meta.url`, which
 * `tsc` refuses under this project's module setting even though vitest is happy with it.
 * The marker is the workspace file, so this holds wherever the runner is started from.
 */
const workspaceRoot = (): string => {
  let at = process.cwd();
  for (;;) {
    if (existsSync(join(at, "pnpm-workspace.yaml"))) return at;
    const up = dirname(at);
    if (up === at) throw new Error("could not find the workspace root from " + process.cwd());
    at = up;
  }
};

const DOC = join(workspaceRoot(), "docs", "TENANT_CONFIGURATION.md");

describe("the tenant configuration surface", () => {
  it("matches the document checked in beside it", () => {
    const rendered = renderConfigurationSurface();

    if (process.env["WRITE_DOCS"] === "1") {
      writeFileSync(DOC, rendered, "utf8");
    }

    const onDisk = readFileSync(DOC, "utf8");
    expect(onDisk).toBe(rendered);
  });

  it("names every guarantee a tenant is not allowed to switch off", () => {
    const rendered = renderConfigurationSurface();

    // Spot-checked rather than trusted: the table is generated from ENFORCED_IN_CODE, and
    // an empty list would render an empty table and pass the comparison above happily.
    for (const requirement of ["R4.3.1", "R5.3", "R6.7", "R7.2"]) {
      expect(rendered).toContain(requirement);
    }
    expect(rendered).toContain("dialled_number");
  });
});
