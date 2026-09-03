// Fails when something is exported that nothing outside its own file calls.
//
// Written after building three tested modules that nothing invoked - the readback state
// machine, the event recorder, and recordTurns - and reporting each as done. An unwired
// module is inventory that reads as progress, and it cannot be proved by a phone call,
// which is this project's actual definition of done.
//
// It distinguishes two failures that look identical to a grep:
//
//   dead          nothing references it at all. Delete it.
//   over-exported only its own file uses it. Drop the `export`.
//
// Conflating them cost a build: isOrganizationId looked dead and was in use one line below.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Where exports are policed. The console is deliberately not here: a Next.js app exports a
// default from every page and a server action from every form, and none of those has a
// caller this tool can see.
const ROOTS = ["apps/api/src", "packages"];

// Where a *use* counts, which is a wider place than where exports are policed. The console
// consumes `@ansa/shared` — the flow contract, by subpath — so an export read only from
// `apps/web` is wired, not dead, and calling it dead would send somebody to delete a constant
// the canvas depends on. `.tsx` matters as much as `.ts` here; almost all of that app is
// components.
const USERS = [...ROOTS, "apps/web/src", "tools"];
const EXPORT = /^export (?:const|function|class|async function) ([A-Za-z_][A-Za-z0-9_]*)/gm;

const sh = (args) => {
  try {
    return execFileSync(args[0], args.slice(1), { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const sources = sh([
  "git", "ls-files", "--", ...ROOTS.map((r) => `${r}/**/*.ts`),
]).filter((f) => !f.includes(".test.") && !f.includes("/dist/"));

const home = new Map();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const [, name] of text.matchAll(EXPORT)) if (!home.has(name)) home.set(name, file);
}

const problems = [];
for (const [name, file] of [...home].sort()) {
  const hits = sh([
    "grep", "-rlw", "--include=*.ts", "--include=*.tsx", "--include=*.mjs", name, ...USERS,
  ])
    .filter((h) => !h.includes("/dist/"));
  const elsewhere = hits.filter((h) => h !== file);
  if (elsewhere.length > 0) continue;

  // Same-file use means it works, it is just visible to more of the codebase than it
  // needs to be. Different problem, different fix.
  const ownUses = (readFileSync(file, "utf8").match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
  problems.push({ name, file, kind: ownUses > 1 ? "over-exported" : "dead" });
}

if (problems.length === 0) {
  console.log("wiring: every export has a caller");
  process.exit(0);
}

console.error(`wiring: ${problems.length} export(s) nothing outside their file calls\n`);
for (const p of problems) console.error(`  ${p.kind.padEnd(13)} ${p.name.padEnd(26)} ${p.file}`);
console.error("\n  dead          -> delete it");
console.error("  over-exported -> drop the `export`, it already works");
process.exit(1);
