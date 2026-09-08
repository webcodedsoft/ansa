#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs a command with the repo-root `.env` loaded, for development only.
 *
 * The apps read `process.env` directly and deliberately: a deployed process takes its
 * configuration from the real environment, never from a file that happens to be in the working
 * copy. That decision is right and this does not change it — which is why the loading lives in
 * the dev script rather than in `main.ts`.
 *
 * What it fixes is that `pnpm dev` only worked in a shell that had already exported everything,
 * and nothing said so. Starting the API in a clean shell died with "Missing required
 * environment variable: PUBLIC_BASE_URL", which reads like a misconfiguration rather than a
 * missing step and sends you looking in the wrong place.
 *
 * **The real environment always wins.** A key already set is left alone, so `PORT=4000 pnpm dev`
 * overrides the file exactly as it should, and a CI runner with its own secrets is unaffected by
 * a stray `.env`. Same rule as `packages/db/src/test-env.ts`, which has done this for tests since
 * before the apps needed it.
 *
 * No dependency: this is twenty lines of parsing, and a dependency here would sit in the boot
 * path of every process a developer starts.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const load = () => {
  let text;
  try {
    text = readFileSync(resolve(root, ".env"), "utf8");
  } catch {
    // No .env is a legitimate setup: the environment supplies the variables directly, as in CI.
    return 0;
  }

  let applied = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (key === "" || process.env[key] !== undefined) continue;

    /* Surrounding quotes are stripped because a shell would strip them, and a value that
       arrives with its quotes attached fails somewhere far from here — a URL that almost
       works, a token that is almost right. */
    let value = trimmed.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);

    process.env[key] = value;
    applied += 1;
  }
  return applied;
};

const applied = load();
const [command, ...args] = process.argv.slice(2);

if (command === undefined) {
  console.error("with-env: give me a command to run, e.g. `node scripts/with-env.mjs nest start`");
  process.exit(2);
}

// Names only, never values: this line goes to a terminal, a scrollback and sometimes a paste.
console.log(`with-env: loaded ${applied} variable${applied === 1 ? "" : "s"} from .env`);

const child = spawn(command, args, { stdio: "inherit", env: process.env, shell: false });

/* Forwarded rather than swallowed, so Ctrl-C stops the dev server instead of orphaning it —
   which is exactly how a `next dev` was left holding port 3100 after its parent was killed. */
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
