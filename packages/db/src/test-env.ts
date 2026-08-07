import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads the repo-root .env for tests. Deliberately not a dependency: the app itself
 * takes configuration from the real environment, and only tests need this.
 */
export const loadDotEnv = (): void => {
  try {
    const text = readFileSync(resolve(process.cwd(), "../../.env"), "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq);
      if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1);
    }
  } catch {
    // No .env: the environment is expected to supply the variables directly, as in CI.
  }
};
