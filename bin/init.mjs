#!/usr/bin/env node
// Orca SDLC Flow Kit — npx scaffolder (delivery only, not pipeline logic).
// Copies the kit into the CWD (the user's project root). Zero dependencies:
// Node builtins only. Spec: docs/superpowers/specs/2026-09-06-npx-install-design.md
//
// Usage:
//   npx github:vankhangfet/orca-sdlc-kit            # install (existing files kept)
//   npx github:vankhangfet/orca-sdlc-kit --force    # overwrite existing files
//
// Rules:
//   - explicit whitelist ONLY: the repo's .orca/ also holds dev/runtime junk
//     (artifacts/, status-preview/, usage-test/) that must never ship.
//   - never clobber existing files without --force (safe upgrades).
//   - no interactive prompts (must be scriptable in CI).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (...a) => console.log("[orca-sdlc-kit]", ...a);
const die = (m) => { console.error("[orca-sdlc-kit] ERROR:", m); process.exit(1); };

// Whitelist — mirrors package.json "files". KEEP THE TWO LISTS IN SYNC.
const FILES = [
  ".orca/flow.mjs",
  ".orca/flow.config.json",
  ".orca/fixbug.config.json",
  ".orca/CONFIGURATION.md",
  ".orca/README.md",
  "orca.yaml",
];

const force = process.argv.slice(2).includes("--force");

// --- Package sanity: verify every source file exists before touching anything ---
const missing = FILES.filter((f) => !existsSync(join(KIT_ROOT, f)));
if (missing.length) die(`corrupt package — missing: ${missing.join(", ")}`);

// --- Copy whitelist into CWD ---
mkdirSync(".orca", { recursive: true });
const copied = [], skipped = [];
try {
  for (const f of FILES) {
    if (existsSync(f) && !force) { skipped.push(f); continue; }
    writeFileSync(f, readFileSync(join(KIT_ROOT, f)));   // Buffer copy = byte-exact
    copied.push(f);
  }
} catch (e) { die(`copy failed: ${e.message}`); }

// --- .gitignore: append the artifacts line exactly once ---
const GI_LINE = ".orca/artifacts/";
const gi = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
const gitignoreAdded = !gi.split(/\r?\n/).includes(GI_LINE);
if (gitignoreAdded) {
  const base = gi ? gi.replace(/\r?\n?$/, "\n") : "";
  try { writeFileSync(".gitignore", base + GI_LINE + "\n"); }
  catch (e) { die(`could not update .gitignore: ${e.message}`); }
}

// --- Report + next steps ---
log(`installing into ${process.cwd()}`);
for (const f of copied) log(`  installed   ${f}`);
for (const f of skipped) log(`  kept yours  ${f}  (already exists; --force to overwrite)`);
if (gitignoreAdded) log(`  updated     .gitignore  (+ ${GI_LINE})`);
log("");
log("Next steps:");
log("  1. Orca: Settings -> Experimental -> enable Orchestration (check: orca status --json)");
log("  2. Create a worktree in Orca — the hook prepares .orca/artifacts for you");
log('  3. Preview, then run:  node .orca/flow.mjs --dry-run "Build a login page"');
log('                        node .orca/flow.mjs "Build a login page"');
