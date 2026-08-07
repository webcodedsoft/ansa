import { defineConfig } from "vitest/config";

// These are integration tests against a real Postgres over the network. Round trips to
// a managed database are tens to hundreds of milliseconds each, so the 5s default fails
// on latency rather than on correctness.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
