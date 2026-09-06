#!/usr/bin/env node
// Breadcrumb enrollment (BRC-SPEC-002 §12).
//
// Copies the plugin into ~/.config/opencode/plugins/ on this machine. Two
// files are copied (the plugin and the shared state module it imports at
// runtime); opencode's plugin glob is non-recursive, so the shared module
// lives in a sibling subdirectory. No build step: opencode runs the
// TypeScript directly.
//
// Usage: node scripts/install.mjs [--dest <dir>]   (default ~/.config/opencode/plugins)

import { cp, mkdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseDest(argv) {
  const i = argv.indexOf("--dest");
  if (i !== -1) {
    const v = argv[i + 1];
    if (!v) throw new Error("--dest requires a value");
    return path.resolve(v);
  }
  return path.join(os.homedir(), ".config", "opencode", "plugins");
}

const dest = parseDest(process.argv.slice(2));
const sources = [
  ["plugin/breadcrumb.ts", "breadcrumb.ts"],
  ["shared/state.ts", "shared/state.ts"],
];

for (const [from, to] of sources) {
  const src = path.join(root, from);
  await stat(src);
  const target = path.join(dest, to);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(src, target);
  console.log(`installed ${to}`);
}

// Drop a stale flat copy of state.ts at the plugin root, if a previous
// version of the installer left one there (it would shadow nothing, but keep
// the directory clean).
await rm(path.join(dest, "state.ts"), { force: true }).catch(() => {});

console.log("");
console.log("Done. Start opencode once; the plugin creates");
console.log("~/.local/share/breadcrumb/ with the machine id and first state file (IDN-011).");
