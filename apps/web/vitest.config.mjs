import { defineConfig } from "vitest/config";

/**
 * The web app's first tests.
 *
 * There were none, which is defensible for pages that mostly compose server components and
 * indefensible for the pure logic that has accumulated beside them — the parsers that decide
 * how a pasted document is split, and therefore what a caller is read. That code has no DOM
 * and no network, so it needs nothing here but a runner.
 *
 * Node rather than jsdom on purpose: the day a test needs a rendered component is the day to
 * add jsdom, and pretending to have a browser before then only slows every run.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
