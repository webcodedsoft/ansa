import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * The web app's tests.
 *
 * There were none, which is defensible for pages that mostly compose server components and
 * indefensible for the pure logic that has accumulated beside them — the parsers that decide
 * how a pasted document is split, and therefore what a caller is read. That code has no DOM
 * and no network, so it needs nothing here but a runner and the `@/` alias.
 *
 * This was two files, `.mjs` holding the test settings and `.mts` the alias, and only one of
 * them ever ran: Vitest resolves the `.mts` first and stops. The other sat there looking
 * authoritative and doing nothing — a deliberate `throw` added to it never fired — so the
 * next person to tune `include` would have watched the change be ignored. One file now.
 *
 * Node rather than jsdom on purpose: the day a test needs a rendered component is the day to
 * add jsdom, and pretending to have a browser before then only slows every run. Until then
 * `jsx: "preserve"` in `tsconfig.json` means Vite will not transform a `.tsx` at all, so a
 * test cannot import one. Feature logic worth testing lives beside the feature as `.ts` and
 * the component in `components/` renders it — which is why `include` names `.ts` and not
 * `.tsx`, rather than that being an oversight.
 */
export default defineConfig({
  resolve: {
    /* The same `@/` that `tsconfig.json` gives the compiler. Next resolves the alias itself,
       so nothing in the app noticed it was missing here until a test imported a module that
       uses one. Repeated rather than read out of the tsconfig: one line against a plugin, for
       a mapping that has been a single entry since the app was made. */
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
