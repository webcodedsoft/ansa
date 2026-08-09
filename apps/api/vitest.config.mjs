import { defineConfig } from "vitest/config";

// Most tests here are pure and finish in microseconds. `src/api/isolation.test.ts` is not:
// it boots the application, talks to a real Postgres over the network, and spends a full
// scrypt on every sign-in. The 5s default fails it on latency rather than on correctness.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
