import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Vitest needs the same `@/` that `tsconfig.json` gives the compiler.
 *
 * Next resolves the alias itself, so nothing in the app noticed it was missing here until a
 * test imported a module that uses one. Repeated rather than read out of the tsconfig: one
 * line against a plugin, for a mapping that has been a single entry since the app was made.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
