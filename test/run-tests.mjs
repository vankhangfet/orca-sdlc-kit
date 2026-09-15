// E2E test harness for .orca/flow.mjs — proves the workflow runs CORRECTLY
// and NEVER HANGS, without touching a real Orca runtime or spawning agents.
//
// How the Orca CLI is faked (zero changes to flow.mjs):
//   ORCA_CLI_COMMAND = node.exe     — spawnable shell-less on every platform
//   NODE_OPTIONS = --require test/orca-preload.cjs
//     → every "orca" spawn becomes node.exe <subcommand> ...; the preload
//       hands it to test/fake-orca.cjs (stateful, scripted per scenario).
// Every scenario runs under a WATCHDOG: exceeding its budget kills the child
// and the scenario FAILS with HUNG — that is the literal "did not hang" check.
//
// Run: node test/run-tests.mjs [--only <substring>]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FLOW = join(REPO, ".orca", "flow.mjs");
const NODE = process.execPath;
const PRELOAD = join(HERE, "orca-preload.cjs");
if (/\s/.test(PRELOAD)) {
  console.error(`FAIL - preload path contains whitespace (${PRELOAD}); move the repo to a space-free path.`);
  process.exit(1);
}

const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
let failed = 0; let total = 0;
const ok = (name, cond, extra) => {
  total++;
  if (cond) console.log("ok -", name);
  else { failed++; console.error("FAIL -", name, extra ?? ""); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Run flow.mjs once under the fake Orca. Config paths are RELATIVE to .orca/
// (flow.mjs joins them with its own directory) — never absolute.
async function runFlow({ name, config, scenario = "default.cjs", args = [], objective = "test objective", seedArtifacts = [], budgetMs = 60000 }) {
  const dir = mkdtempSync(join(tmpdir(), `orca-flow-${name}-`));
  const wt = join(dir, "wt"); const home = join(dir, "home");
  mkdirSync(join(wt, ".orca", "artifacts"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const a of seedArtifacts) writeFileSync(join(wt, ".orca", "artifacts", a.file), a.text ?? "seeded by harness\n");
  const env = {
    ...process.env,
    ORCA_CLI_COMMAND: NODE,
    // Backslashes inside NODE_OPTIONS quotes are eaten by Node's POSIX-style
    // tokenizer (C:\Working -> C:Working), so the preload must be forward-slashed.
    NODE_OPTIONS: `--require "${PRELOAD.split("\\").join("/")}"`,
    ORCA_FAKE_STATE: join(dir, "state.json"),
    ORCA_FAKE_LOG: join(dir, "calls.jsonl"),
    ORCA_FAKE_SCENARIO: join(HERE, "scenarios", scenario),
    ORCA_FAKE_WT: wt,
    ORCA_FLOW_WORKTREE: "name:testlab",
    USERPROFILE: home,
    HOME: home,
  };
  const argv = [FLOW, ...args, "--no-open-status"];
  if (config) argv.push("--config", config);
  if (objective) argv.push(objective);
  const child = spawn(NODE, argv, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = ""; let hung = false;
  const timer = setTimeout(() => { hung = true; child.kill(); }, budgetMs);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  clearTimeout(timer);
  const status = (() => {
    try {
      const txt = readFileSync(join(wt, ".orca", "artifacts", "status.js"), "utf8");
      const m = txt.match(/window\.__STATUS=([\s\S]*?);window\.__ON_STATUS/);
      return m ? JSON.parse(m[1]) : null;
    } catch { return null; }
  })();
  const calls = existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    : [];
  if (!hung) rmSync(dir, { recursive: true, force: true });
  else console.error(`[harness] HUNG child kept ${dir} for inspection`);
  const by = (cmd) => calls.filter((c) => c.cmd === cmd);
  return { code, out, err, hung, status, calls, by, wt, dir };
}

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ---------------------------------------------------------------------------
// E1 — happy path, cold start: terminal create FAILS (default) so every step
// falls back to `worker-start`; each worker reports worker_done/succeeded.
// ---------------------------------------------------------------------------
scenario("E1 happy-cold (2 steps, cold start, both succeed)", async () => {
  const r = await runFlow({ name: "e1", config: "../test/configs/cold.config.json" });
  ok("E1 not hung", !r.hung);
  eq("E1 exit code", r.code, 0);
  ok("E1 alpha ok line", /\[ok\] Alpha done -> \.orca\/artifacts\/A\.md/.test(r.out + r.err));
  ok("E1 beta ok line", /\[ok\] Beta done -> \.orca\/artifacts\/B\.md/.test(r.out + r.err));
  ok("E1 pipeline complete", /Pipeline COMPLETE/.test(r.out));
  eq("E1 status overall", r.status?.overall, "succeeded");
  eq("E1 both steps succeeded", r.status?.steps.filter((s) => s.status === "succeeded").length, 2);
  eq("E1 one task-create per step", r.by("orchestration task-create").length, 2);
  eq("E1 worker-release per dispatch", r.by("orchestration worker-release").length, 2);
});

// ---------------------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    console.log(`\n# ${s.name}`);
    try { await s.fn(); } catch (e) { failed++; total++; console.error("FAIL -", s.name, "threw:", e.message); }
  }
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${total - failed}/${total} assertions passed in ${dt}s`);
  if (failed) console.error(`${failed} FAILURE(S)`);
  process.exit(failed ? 1 : 0);
})();
