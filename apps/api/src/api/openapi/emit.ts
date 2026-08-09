import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { API_CONTROLLERS } from "../api.module";
import { renderClient } from "./client";
import { buildDocument, SPEC_PATH, specInfo } from "./document";

/**
 * Writes `openapi.json`, and the client when asked for one.
 *
 *   pnpm --filter @ansa/api openapi
 *   pnpm --filter @ansa/api openapi -- --client ../web/src/ansa-api.ts
 *
 * The spec is committed because it is the contract and a change to it should be visible in
 * a diff. The client is not: it is a build artefact of whichever frontend consumes it, and
 * a generated file in this repository would be one more thing to keep green for no reader.
 */
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

const write = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
  process.stdout.write(`wrote ${path}\n`);
};

const document = buildDocument(API_CONTROLLERS, specInfo());

// Relative to the package root, which is where pnpm runs the script from.
write(resolve(process.cwd(), SPEC_PATH), `${JSON.stringify(document, null, 2)}\n`);

const clientPath = argument("client");
if (clientPath !== undefined) write(resolve(process.cwd(), clientPath), renderClient(document));
