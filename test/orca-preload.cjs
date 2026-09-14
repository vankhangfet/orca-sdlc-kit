// NODE_OPTIONS=--require shim for the E2E test suite (see test/run-tests.mjs).
//
// flow.mjs talks to the Orca CLI via spawnSync(ORCA_CLI_COMMAND, args) with no
// shell. On Windows + Node >= 22 a .cmd stub cannot be spawned (EINVAL), and a
// script file cannot be spawned at all — so the harness points
// ORCA_CLI_COMMAND at node.exe itself and preloads THIS file via NODE_OPTIONS.
// Every faked CLI call is then `node.exe orchestration ... --json`: Node runs
// this preload before resolving the (nonexistent) main module "orchestration",
// we recognize the argv shape and hand off to fake-orca.cjs, which prints JSON
// and exits — Node never gets as far as failing on the missing module.
//
// Every OTHER node process (flow.mjs itself, the harness) has an argv[1] that
// is an existing file: the existsSync guard makes the preload a no-op there.
const fs = require("node:fs");
const path = require("node:path");

const ORCA_CMDS = new Set(["orchestration", "terminal", "worktree", "status"]);
const a1 = process.argv[1];
if (a1 && !fs.existsSync(a1) && ORCA_CMDS.has(path.basename(a1))) {
  // argv[1] is the command word (resolved to an absolute path by Node), so it
  // must be re-joined as its basename: fake-orca keys handlers on the full
  // "orchestration run-create" / "status" command, as flow.mjs's orca() spells it.
  require("./fake-orca.cjs").main([path.basename(a1), ...process.argv.slice(2)]);
  process.exit(0); // defensive: fake-orca.main exits on its own
}
