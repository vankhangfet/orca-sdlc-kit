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
// A FAILING or HUNG scenario keeps its tmp dir for inspection; the runner
// deletes a passing scenario's dirs only after the scenario finishes.
//
// Run: node test/run-tests.mjs [--only <substring>]
// (--only is a case-sensitive substring on scenario names: "--only F" also matches E7's "onFailGoto".)
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createServer } from "node:http";
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
if (process.argv.includes("--only") && !only) { console.error("FAIL - --only requires a non-empty substring"); process.exit(1); }
let failed = 0; let total = 0;
const ok = (name, cond, extra) => {
  total++;
  if (cond) console.log("ok -", name);
  else { failed++; console.error("FAIL -", name, extra ?? ""); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// Tiny localhost webhook recorder for the notification scenarios (N1).
async function recordHook() {
  const hits = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("error", () => {});   // aborted client must not crash the runner
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      let body = null;
      try { body = b ? JSON.parse(b) : null; } catch { body = `<unparseable: ${b.slice(0, 120)}>`; }
      hits.push({ path: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  const listening = new Promise((r) => srv.listen(0, "127.0.0.1", r));
  srv.on("error", (e) => { throw e; });   // failed listen must fail loudly, not hang the suite
  await listening;
  const url = `http://127.0.0.1:${srv.address().port}/hook`;
  const close = () => new Promise((r) => srv.close(r));
  return { hits, url, close };
}

// Tmp dirs survive runFlow; the runner decides their fate AFTER the scenario,
// so failure evidence (calls.jsonl/state.json/status.js) still exists when
// assertions report FAIL. Same for HUNG — runFlow sets the flag when it kills.
let dirsOfCurrentScenario = [];
let hungInCurrentScenario = false;

// Run flow.mjs once under the fake Orca. Config paths are RELATIVE to .orca/
// (flow.mjs joins them with its own directory) — never absolute.
// default budget: well above the configs' hard caps so a slow machine cannot produce a false HUNG
// NOTE: call sites pass the property key "scenario:" — a mismatch silently falls back to default.cjs (the green-path trap this param's name once caused).
async function runFlow({ name, config, scenario: scenarioFile = "default.cjs", args = [], objective = "test objective", seedArtifacts = [], stdinText = null, budgetMs = 90000, notify = null, reuseDir = null }) {
  const dir = reuseDir ?? mkdtempSync(join(tmpdir(), `orca-flow-${name}-`));
  if (!dirsOfCurrentScenario.includes(dir)) dirsOfCurrentScenario.push(dir);
  const wt = join(dir, "wt"); const home = join(dir, "home");
  mkdirSync(join(wt, ".orca", "artifacts"), { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const a of seedArtifacts) writeFileSync(join(wt, ".orca", "artifacts", a.file), a.text ?? "seeded by harness\n");
  if (notify) writeFileSync(join(dir, "notify.json"), JSON.stringify(notify, null, 2));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("ORCA_")) delete env[k];
  env.ORCA_CLI_COMMAND = NODE;
  // Backslashes inside NODE_OPTIONS quotes are eaten by Node's POSIX-style
  // tokenizer (C:\Working -> C:Working), so the preload must be forward-slashed.
  env.NODE_OPTIONS = `--require "${PRELOAD.split("\\").join("/")}"`;
  env.ORCA_FAKE_STATE = join(dir, "state.json");
  env.ORCA_FAKE_LOG = join(dir, "calls.jsonl");
  env.ORCA_FAKE_SCENARIO = join(HERE, "scenarios", scenarioFile);
  env.ORCA_FAKE_WT = wt;
  // Title -> writes map: lets the fake materialize each step's artifact on
  // success, exactly like a real worker leaving its {out} file behind.
  env.ORCA_FAKE_WRITES = (() => {
    try {
      const cc = JSON.parse(readFileSync(join(REPO, ".orca", config ?? "flow.config.json"), "utf8"));
      return JSON.stringify(Object.fromEntries(
        (cc.pipeline || []).filter((s) => s && s.title && s.writes).map((s) => [s.title, s.writes])));
    } catch { return "{}"; }
  })();
  env.ORCA_FLOW_WORKTREE = "name:testlab";
  // notify template, when given, is handed to the child via its file's path — the
  // only source, since every inherited ORCA_* key was stripped above.
  if (notify) env.ORCA_FLOW_NOTIFY_FILE = join(dir, "notify.json");
  env.USERPROFILE = home;
  env.HOME = home;
  const argv = [FLOW, ...args, "--no-open-status"];
  if (config) argv.push("--config", config);
  if (objective) argv.push(objective);
  const child = spawn(NODE, argv, { cwd: REPO, env, stdio: [stdinText == null ? "ignore" : "pipe", "pipe", "pipe"] });
  if (stdinText != null) { child.stdin.on("error", () => {}); child.stdin.write(stdinText); child.stdin.end(); }
  let out = ""; let err = ""; let hung = false;
  const timer = setTimeout(() => { hung = true; hungInCurrentScenario = true; child.kill(); }, budgetMs);
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
  ok("E1 artifact materialized", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
});

// ---------------------------------------------------------------------------
// E4 — hard cap: silent, frozen-preview worker. Must settle as still-running
// with the resume hint; the watchdog proves the process itself ends.
// ---------------------------------------------------------------------------
scenario("E4 hardcap (silent frozen worker settles via hardTimeoutMs)", async () => {
  const r = await runFlow({ name: "e4", config: "../test/configs/hang.config.json", scenario: "hang.cjs", budgetMs: 45000 });
  ok("E4 not hung", !r.hung);
  eq("E4 exit code", r.code, 1);
  ok("E4 hard-cap message", /not settled after \d+min; leaving its terminal open/.test(r.out + r.err));
  ok("E4 resume hint", /--from beta/.test(r.out + r.err));
  eq("E4 status overall", r.status?.overall, "still-running");
  ok("E4 alpha still-running note", /not settled after/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E5 — quiet-but-alive: one warning, no premature failure, hard-cap exit.
// ---------------------------------------------------------------------------
scenario("E5 quiet-warn (alive dispatch, one warning, no premature fail)", async () => {
  const r = await runFlow({ name: "e5", config: "../test/configs/hang.config.json", scenario: "stale-heartbeat.cjs", budgetMs: 45000 });
  ok("E5 not hung", !r.hung);
  eq("E5 exit code", r.code, 1);
  const warns = (r.out + r.err).match(/quiet for \d+min but its dispatch is alive/g) || [];
  eq("E5 exactly one quiet warning", warns.length, 1);
  ok("E5 waited to hard cap", /waiting up to the \d+min hard cap/.test(r.out + r.err));
  eq("E5 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E6 — parked on a permission prompt: observe, never answer, hard-cap exit.
// ---------------------------------------------------------------------------
scenario("E6 parked-prompt (frozen dialog: warn, never answer, hard cap)", async () => {
  const r = await runFlow({ name: "e6", config: "../test/configs/hang.config.json", scenario: "parked.cjs", budgetMs: 45000 });
  ok("E6 not hung", !r.hung);
  eq("E6 exit code", r.code, 1);
  ok("E6 parked warning", /PARKED on a permission-rule confirmation/.test(r.out + r.err));
  // The parked diagnosis must SURVIVE the hard cap: the status page is the
  // thing a human opens after the run stops, so the final note must say what
  // the worker was parked on AND that the cap fired (not the generic
  // "not settled after" alone — that loses the actionable diagnosis).
  ok("E6 status note keeps the parked diagnosis", /parked on a permission-rule confirmation — not settled after \d+min/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
  eq("E6 flow never answered the prompt", r.by("terminal send").length, 0);
  eq("E6 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E7 — onFailGoto fix loop: fail once, jump back, reopen (not re-create),
// succeed on the second pass.
// ---------------------------------------------------------------------------
scenario("E7 fail-retry (onFailGoto reopens the fix target once)", async () => {
  const r = await runFlow({ name: "e7", config: "../test/configs/retry.config.json", scenario: "reviewer-fail-once.cjs", budgetMs: 90000 });
  ok("E7 not hung", !r.hung);
  eq("E7 exit code", r.code, 0);
  // Optional note segment: since the nudge engine (v2.1.0 spec, decision table
  // "No resolvable terminal"), a failed step with a missing artifact carries
  // e.g. "(artifact missing (no terminal to nudge))" — outcome stays original.
  ok("E7 fail jump logged", /\[fail\] Reviewer FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/1\)/.test(r.out + r.err));
  eq("E7 one task-create per step (no double dispatch)", r.by("orchestration task-create").length, 2);
  const reopens = r.by("orchestration task-update").filter((c) => c.flags.status === "ready");
  ok("E7 target reopened", reopens.length >= 1);
  ok("E7 fix note recorded", reopens.some((c) => String(c.flags.result ?? "").includes("fix from reviewer")));
  eq("E7 status overall", r.status?.overall, "succeeded");
  eq("E7 coder attempt 2", r.status?.steps.find((s) => s.id === "coder")?.attempt, 2);
});

// ---------------------------------------------------------------------------
// E8 — retries are finite: exhausted maxRetries dies instead of looping.
// ---------------------------------------------------------------------------
scenario("E8 retry-exhaust (loop is finite)", async () => {
  const r = await runFlow({ name: "e8", config: "../test/configs/retry.config.json", scenario: "reviewer-fail-always.cjs", budgetMs: 90000 });
  ok("E8 not hung", !r.hung);
  eq("E8 exit code", r.code, 1);
  ok("E8 exhausted message", /exhausted 1 retries/.test(r.out + r.err));
  eq("E8 worker-start count bounded (2+2)", r.by("orchestration worker-start").length, 4);
});

// ---------------------------------------------------------------------------
// E31 — parallel REVIEW group + onFailGoto: Security Review fails once inside
// the [code-review ∥ security-review] group; the fix loop jumps back to the
// Coder and the retry re-runs the WHOLE group — a second dispatch for BOTH
// review members, not just the failed one. Expected worker-starts: coder,
// both reviews (round 1), coder (fix), both reviews (round 2), testing = 7.
// ---------------------------------------------------------------------------
scenario("E31 parallel-review fail-retry (group re-runs both reviews after fix)", async () => {
  const r = await runFlow({ name: "e31", config: "../test/configs/parallel-review.config.json",
    scenario: "parallel-review-fail-once.cjs", budgetMs: 90000 });
  ok("E31 not hung", !r.hung);
  eq("E31 exit code", r.code, 0);
  const starts = r.calls.map((c, i) => (c.cmd === "orchestration worker-start" ? i : -1)).filter((i) => i > -1);
  const checkAfterFirstReview = r.calls.findIndex((c, i) => c.cmd === "orchestration check" && i > starts[1]);
  ok("E31 both reviews launched before the group's first wait", starts[2] > -1 && checkAfterFirstReview > starts[2]);
  ok("E31 fail jump logged", /\[fail\] Security Review FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/1\)/.test(r.out + r.err));
  eq("E31 one task-create per step (cached tasks reopened, not re-created)", r.by("orchestration task-create").length, 4);
  eq("E31 worker-start total (coder x2, each review x2, testing x1)", r.by("orchestration worker-start").length, 7);
  const reopens = r.by("orchestration task-update").filter((c) => c.flags.status === "ready");
  ok("E31 coder reopened with fix note", reopens.some((c) => String(c.flags.result ?? "").includes("fix from security-review")));
  eq("E31 security-review flagged parallel", r.status?.steps.find((s) => s.id === "security-review")?.parallel, true);
  eq("E31 coder attempt 2", r.status?.steps.find((s) => s.id === "coder")?.attempt, 2);
  eq("E31 security-review attempt 2", r.status?.steps.find((s) => s.id === "security-review")?.attempt, 2);
  const joinCreate = r.calls.findIndex((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("# Testing"));
  const checkAfterRetry = r.calls.findIndex((c, i) => c.cmd === "orchestration check" && i > starts[5]);
  ok("E31 testing tasked only after the retry round settles", joinCreate > -1 && checkAfterRetry > -1 && joinCreate > checkAfterRetry);
  ok("E31 testing ok line (join after both reviews)", /\[ok\] Testing done -> \.orca\/artifacts\/TEST_REPORT\.md/.test(r.out + r.err));
  eq("E31 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E32 — per-step maxRetries: the reviewer declares maxRetries:3 over the
// global 1; the fix loop must honor the STEP budget — attempts render n/3,
// exhaustion lands at 3, and the coder is re-dispatched exactly 3 times.
// ---------------------------------------------------------------------------
scenario("E32 retry-per-step (step budget overrides global)", async () => {
  const r = await runFlow({ name: "e32", config: "../test/configs/retry-per-step.config.json", scenario: "reviewer-fail-always.cjs", budgetMs: 90000 });
  ok("E32 not hung", !r.hung);
  eq("E32 exit code", r.code, 1);
  const log = r.out + r.err;
  ok("E32 attempt 1/3", /\[fail\] Reviewer FAILED( \(.*\))? -> back to "Coder" \(attempt 1\/3\)/.test(log));
  ok("E32 attempt 2/3", /\(attempt 2\/3\)/.test(log));
  ok("E32 attempt 3/3", /\(attempt 3\/3\)/.test(log));
  ok("E32 exhausted at step budget", /exhausted 3 retries/.test(log));
  ok("E32 never used the global budget", !/exhausted 1 retries/.test(log));
  eq("E32 worker-start count bounded (4 coder + 4 reviewer)", r.by("orchestration worker-start").length, 8);
});

// ---------------------------------------------------------------------------
// E2 — manual start path: warm the TUI, fetch the preamble, substitute
// ctx_dryrun, paste + bare-Enter, verify consumption, close on settle.
// Also pins the AUTO-RUN claude command wrap.
// ---------------------------------------------------------------------------
scenario("E2 happy-manual (warm-up, paste ladder, claude wrap, close)", async () => {
  const r = await runFlow({ name: "e2", config: "../test/configs/manual.config.json", scenario: "terminal-ok.cjs", budgetMs: 150000 });
  ok("E2 not hung", !r.hung);
  eq("E2 exit code", r.code, 0);
  const create = r.by("terminal create");
  eq("E2 one terminal created", create.length, 1);
  const cmd = String(create[0]?.flags.command ?? "");
  ok("E2 claude wrap: bypass permissions", cmd.includes("--permission-mode bypassPermissions"));
  ok("E2 claude wrap: AFK timeout env", cmd.includes("CLAUDE_AFK_TIMEOUT_MS=60000"));
  const sends = r.by("terminal send");
  ok("E2 preamble sent (spec head present)", sends.some((c) => String(c.flags.text ?? "").includes("# Solo")));
  ok("E2 dry-run placeholder replaced", sends.every((c) => !String(c.flags.text ?? "").includes("ctx_dryrun")));
  ok("E2 real dispatch id substituted", sends.some((c) => /dispatch=disp-\d+/.test(String(c.flags.text ?? ""))));
  ok("E2 bare-enter follow-up sent", sends.some((c) => c.flags.text === ""));
  eq("E2 terminal closed", r.by("terminal close").length, 1);
  eq("E2 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E3 — parallel group: both members launch BEFORE either settles; the join
// step runs only after both.
// ---------------------------------------------------------------------------
scenario("E3 parallel-happy (group launches together, join waits)", async () => {
  const r = await runFlow({ name: "e3", config: "../test/configs/parallel.config.json", budgetMs: 90000 });
  ok("E3 not hung", !r.hung);
  eq("E3 exit code", r.code, 0);
  eq("E3 three task-creates", r.by("orchestration task-create").length, 3);
  const cmds = r.calls.map((c) => c.cmd);
  const firstStart = cmds.indexOf("orchestration worker-start");
  const secondStart = cmds.indexOf("orchestration worker-start", firstStart + 1);
  const firstCheck = cmds.indexOf("orchestration check");
  ok("E3 both members started before the first wait", firstStart > -1 && secondStart > -1 && firstCheck > secondStart);
  const joinCreate = r.calls.findIndex((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("Join"));
  ok("E3 join tasked only after the group settles", joinCreate > firstCheck);
  eq("E3 worker-start count (no double dispatch in group)", r.by("orchestration worker-start").length, 3);
  eq("E3 right flagged parallel", r.status?.steps.find((s) => s.id === "right")?.parallel, true);
  ok("E3 join ok line", /\[ok\] Join done -> \.orca\/artifacts\/P3\.md/.test(r.out + r.err));
  eq("E3 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E9 — manual-mode gate: blocks (waiting-approval), then a yes resolves it.
// ---------------------------------------------------------------------------
scenario("E9 gate-approve (manual mode gate blocks, then resolves yes)", async () => {
  const r = await runFlow({ name: "e9", config: "../test/configs/gate.config.json", scenario: "gate-resolve.cjs", budgetMs: 90000 });
  ok("E9 not hung", !r.hung);
  eq("E9 exit code", r.code, 0);
  ok("E9 gate created", r.by("orchestration gate-create").length === 1);
  const polls = r.by("orchestration gate-list").length;
  ok("E9 gate polled to resolution", polls >= 2);
  ok("E9 gate polled to resolution (bounded)", polls <= 6);
  ok("E9 gate announced", /\[gate\] for "Build"/.test(r.out + r.err));
  eq("E9 build succeeded after gate", r.status?.steps.find((s) => s.id === "build")?.status, "succeeded");
  eq("E9 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// E10 — unknown outcome: no blind retry, exactly one dispatch.
// ---------------------------------------------------------------------------
scenario("E10 unknown-outcome (no blind retry)", async () => {
  const r = await runFlow({ name: "e10", config: "../test/configs/cold.config.json", scenario: "unknown-outcome.cjs", budgetMs: 90000 });
  ok("E10 not hung", !r.hung);
  eq("E10 exit code", r.code, 1);
  ok("E10 no-blind-retry message", /Not retrying without a definite failure/.test(r.out + r.err));
  ok("E10 outcome=unknown surfaced", /outcome=unknown/.test(r.out + r.err));
  eq("E10 exactly one dispatch (no double dispatch)", r.by("orchestration worker-start").length, 1);
});

// ---------------------------------------------------------------------------
// E11 — resume: --from keeps the read chain via the prior artifact file.
// ---------------------------------------------------------------------------
scenario("E11 resume-from (--from keeps the read chain)", async () => {
  const seed = [{ file: "A.md", text: "# Alpha output\nprior run artifact\n" +
    "seeded filler line so the resume seed clears the readiness minimum-size threshold.\n".repeat(4) }];
  const dry = await runFlow({ name: "e11dry", config: "../test/configs/cold.config.json", args: ["--dry-run", "--from", "beta"], seedArtifacts: seed, budgetMs: 30000 });
  eq("E11 dry-run exit", dry.code, 0);
  ok("E11 dry-run reads include prior step", /reads=\[alpha\]/.test(dry.out));

  const run = await runFlow({ name: "e11run", config: "../test/configs/cold.config.json", args: ["--from", "beta"], seedArtifacts: seed, budgetMs: 90000 });
  ok("E11 not hung", !run.hung);
  eq("E11 run exit code", run.code, 0);
  eq("E11 only beta tasked", run.by("orchestration task-create").length, 1);
  ok("E11 beta spec points at prior artifact", String(run.by("orchestration task-create")[0]?.flags.spec ?? "").includes(".orca/artifacts/A.md"));
  eq("E11 alpha skipped on resume", run.status?.steps.find((s) => s.id === "alpha")?.status, "skipped");
  eq("E11 beta succeeded", run.status?.steps.find((s) => s.id === "beta")?.status, "succeeded");
});

// ---------------------------------------------------------------------------
// E12 — readiness gate, decline: a declared read with NO artifact on disk must
// stop the run BEFORE dispatching the consumer (stdin EOF = decline).
// ---------------------------------------------------------------------------
scenario("E12 readiness-abort (missing read -> prompt -> decline -> stop)", async () => {
  const r = await runFlow({ name: "e12", config: "../test/configs/cold.config.json", args: ["--only", "beta"], budgetMs: 45000 });
  ok("E12 not hung", !r.hung);
  eq("E12 exit code", r.code, 1);
  ok("E12 missing-input report", /Missing or incomplete input artifact\(s\):/.test(r.out + r.err));
  ok("E12 names the artifact", /Alpha \(`\.orca\/artifacts\/A\.md`\) — missing/.test(r.out + r.err));
  ok("E12 asks the user", /Run the producing step\(s\) now .* \[y\/N\]/.test(r.out + r.err));
  ok("E12 resume hint", /--from alpha/.test(r.out + r.err));
  eq("E12 consumer never dispatched", r.by("orchestration task-create").length, 0);
  eq("E12 status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E13 — readiness gate, accept: "y" re-runs the producer (out-of-run via
// --only), the fake writes the artifact, the consumer then completes.
// ---------------------------------------------------------------------------
scenario("E13 readiness-repair (prompt yes -> re-run producer -> continue)", async () => {
  const r = await runFlow({ name: "e13", config: "../test/configs/cold.config.json", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E13 not hung", !r.hung);
  eq("E13 exit code", r.code, 0);
  ok("E13 repair attempt logged", /\[readiness\] re-running "Alpha" \(attempt 1\/3\)/.test(r.out + r.err));
  ok("E13 artifact ready logged", /\[readiness\] "Alpha" artifact ready -> \.orca\/artifacts\/A\.md/.test(r.out + r.err));
  eq("E13 both steps tasked (producer + consumer)", r.by("orchestration task-create").length, 2);
  eq("E13 producer tasked fresh, no reopen needed", r.by("orchestration task-update").filter((c) => c.flags.status === "ready").length, 0);
  eq("E13 alpha succeeded after repair", r.status?.steps.find((s) => s.id === "alpha")?.status, "succeeded");
  eq("E13 beta succeeded", r.status?.steps.find((s) => s.id === "beta")?.status, "succeeded");
  eq("E13 status overall", r.status?.overall, "succeeded");
  ok("E13 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E14 — readiness retries are finite: producer "succeeds" without writing the
// file; exactly readinessRetries (3) attempts, then the run stops.
// ---------------------------------------------------------------------------
scenario("E14 readiness-exhaust (3 attempts, then stop)", async () => {
  const r = await runFlow({ name: "e14", config: "../test/configs/cold.config.json", scenario: "no-artifact.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E14 not hung", !r.hung);
  eq("E14 exit code", r.code, 1);
  eq("E14 exactly 3 repair dispatches", r.by("orchestration worker-start").length, 3);
  ok("E14 attempt 3 logged", /\[readiness\] re-running "Alpha" \(attempt 3\/3\)/.test(r.out + r.err));
  ok("E14 exhausted message", /still has no usable artifact after 3 readiness retries/.test(r.out + r.err));
  eq("E14 consumer never dispatched", r.by("orchestration task-create").length, 1);   // alpha only
  eq("E14 status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E14b — a repair attempt that settles outcome=unknown WITHOUT the artifact
// must not be blindly re-dispatched (double-dispatch doctrine), even with
// retries remaining.
// ---------------------------------------------------------------------------
scenario("E14b readiness-unknown (no blind retry during repair)", async () => {
  const r = await runFlow({ name: "e14b", config: "../test/configs/cold.config.json", scenario: "repair-unknown.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 60000 });
  ok("E14b not hung", !r.hung);
  eq("E14b exit code", r.code, 1);
  ok("E14b no-blind-retry message", /not retrying without a definite outcome/.test(r.out + r.err));
  eq("E14b exactly one repair dispatch", r.by("orchestration worker-start").length, 1);
  eq("E14b status overall", r.status?.overall, "failed");
});

// ---------------------------------------------------------------------------
// E15 — min-size verdict: an existing but undersized artifact (5 bytes < the
// 200 default) is unready; declining stops the run with the too-small reason.
// ---------------------------------------------------------------------------
scenario("E15 readiness-min-bytes (undersized artifact is unready)", async () => {
  const r = await runFlow({ name: "e15", config: "../test/configs/cold.config.json", args: ["--only", "beta"], seedArtifacts: [{ file: "A.md", text: "tiny\n" }], budgetMs: 45000 });
  ok("E15 not hung", !r.hung);
  eq("E15 exit code", r.code, 1);
  ok("E15 too-small reason", /too small \(5 bytes < 200 min\)/.test(r.out + r.err));
  ok("E15 resume hint", /--from alpha/.test(r.out + r.err));
  eq("E15 consumer never dispatched", r.by("orchestration task-create").length, 0);
});

// ---------------------------------------------------------------------------
// E16 — readiness repair is TRANSITIVE: repairing a producer whose own reads
// are also missing must repair the whole chain, in pipeline order.
// ---------------------------------------------------------------------------
scenario("E16 readiness-transitive (repair walks the read chain)", async () => {
  const r = await runFlow({ name: "e16", config: "../test/configs/chain.config.json", args: ["--only", "gamma"], stdinText: "y\n", budgetMs: 60000 });
  ok("E16 not hung", !r.hung);
  eq("E16 exit code", r.code, 0);
  eq("E16 whole chain repaired (3 dispatches)", r.by("orchestration worker-start").length, 3);
  const order = r.calls.map((c) => {
    if (c.cmd !== "orchestration task-create") return null;
    return (String(c.flags.spec ?? "").match(/^# (.+)$/m) || [])[1] || "?";
  }).filter(Boolean);
  eq("E16 repair order follows the pipeline", order, ["Alpha", "Beta", "Gamma"]);
  ok("E16 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E17 — a repair attempt that never settles exits still-running with the
// consumer-group resume hint (terminal left open), like the main loop does.
// ---------------------------------------------------------------------------
scenario("E17 repair-hang (still-running repair keeps the resume hint)", async () => {
  const r = await runFlow({ name: "e17", config: "../test/configs/hang.config.json", scenario: "hang.cjs", args: ["--only", "beta"], stdinText: "y\n", budgetMs: 45000 });
  ok("E17 not hung", !r.hung);
  eq("E17 exit code", r.code, 1);
  ok("E17 still-running message names the producer", /"Alpha" [^\n]*was left OPEN to finish/.test(r.out + r.err));
  ok("E17 resume hint points at the consumer", /--from beta/.test(r.out + r.err));
  eq("E17 one repair dispatch", r.by("orchestration worker-start").length, 1);
  ok("E17 producer hard-cap note", /not settled after \d+min/.test(r.status?.steps.find((s) => s.id === "alpha")?.note ?? ""));
  eq("E17 status overall", r.status?.overall, "still-running");
});

// ---------------------------------------------------------------------------
// E18 — shipped default config on a fresh worktree: reads of config-DISABLED
// steps (grill) are optional inputs — the gate must not prompt or abort.
// ---------------------------------------------------------------------------
scenario("E18 readiness-skips-disabled (shipped config, fresh worktree, no prompt)", async () => {
  const r = await runFlow({ name: "e18", config: null, budgetMs: 120000 });
  ok("E18 not hung", !r.hung);
  eq("E18 exit code", r.code, 0);
  ok("E18 never reported missing inputs", !/Missing or incomplete input artifact/.test(r.out + r.err));
  ok("E18 never prompted", !/Run the producing step/.test(r.out + r.err));
  eq("E18 grill stays skipped", r.status?.steps.find((s) => s.id === "grill")?.status, "skipped");
  ok("E18 planning dispatched", r.calls.some((c) => c.cmd === "orchestration task-create" && String(c.flags.spec ?? "").includes("# Planning")));
  ok("E18 pipeline complete", /Pipeline COMPLETE/.test(r.out));
});

// ---------------------------------------------------------------------------
// E19 — nudge post-done recovery: worker_done(succeeded) but no artifact =>
// nudge the terminal; the file appears; the step settles with the ORIGINAL
// outcome and a recovered note. A further worker_done while held must not
// settle a member whose file was missing.
// ---------------------------------------------------------------------------
scenario("E19 nudge post-done recovery", async () => {
  const r = await runFlow({ name: "e19", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-recover.cjs", budgetMs: 60000 });
  ok("E19 not hung", !r.hung);
  eq("E19 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E19 exactly one nudge text", textSends.length, 1);
  ok("E19 nudge names the artifact path", /\.orca\/artifacts\/A\.md/.test(String(textSends[0]?.flags.text ?? "")));
  eq("E19 status overall", r.status?.overall, "succeeded");
  ok("E19 recovered note", /artifact recovered via nudge \(1 sent\)/.test(r.status?.steps[0]?.note ?? ""));
  ok("E19 artifact exists", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
  ok("E19 terminal closed at settlement", r.by("terminal close").length === 1);
});

// ---------------------------------------------------------------------------
// E24 — a mid-run nudge send FAILURE closes the budget without a delivered
// nudge; done-without-artifact then settles with the ORIGINAL outcome and an
// "(nudge undeliverable)" note — never "failed after 0 nudge(s)".
// ---------------------------------------------------------------------------
scenario("E24 nudge undeliverable keeps original outcome", async () => {
  const r = await runFlow({ name: "e24", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-undeliverable.cjs", budgetMs: 60000 });
  ok("E24 not hung", !r.hung);
  eq("E24 exit code", r.code, 0);
  ok("E24 a send was attempted", r.by("terminal send").length >= 1);
  eq("E24 status overall", r.status?.overall, "succeeded");
  ok("E24 undeliverable note", /artifact missing \(nudge undeliverable\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E25 — post-done nudge safety: a terminal parked on a dialog after
// worker_done is NEVER typed into; the step keeps the original outcome.
// ---------------------------------------------------------------------------
scenario("E25 post-done parked terminal is not nudged", async () => {
  const r = await runFlow({ name: "e25", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-post-parked.cjs", budgetMs: 60000 });
  ok("E25 not hung", !r.hung);
  eq("E25 zero terminal sends", r.by("terminal send").length, 0);
  eq("E25 exit code", r.code, 0);
  eq("E25 status overall", r.status?.overall, "succeeded");
  ok("E25 parked note", /artifact missing \(terminal parked on the folder-trust check\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E26 — post-done RE-nudge safety: a dialog that parks BETWEEN nudges is
// never typed into; the step keeps the original outcome (parked note).
// ---------------------------------------------------------------------------
scenario("E26 re-nudge spared when terminal reparks", async () => {
  const r = await runFlow({ name: "e26", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-post-reparked.cjs", budgetMs: 60000 });
  ok("E26 not hung", !r.hung);
  eq("E26 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E26 exactly one nudge text (re-nudge suppressed)", textSends.length, 1);
  eq("E26 status overall", r.status?.overall, "succeeded");
  ok("E26 parked note", /artifact missing \(terminal parked on the folder-trust check\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E27 — run history: starting a NEW run snapshots the previous run's flat
// artifacts into runs/<seq>-<ts>/ (copy, not move — flat files stay for
// readiness/resume). A marker written between runs discriminates the
// archived copy from the run-2 overwrite.
// ---------------------------------------------------------------------------
scenario("E27 archive previous run on new run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e27", config: cfg });
  ok("E27 run1 ok", r1.code === 0 && !r1.hung);
  writeFileSync(join(r1.wt, ".orca", "artifacts", "A.md"), "RUN1 MARKER\n");
  const r2 = await runFlow({ name: "e27", config: cfg, reuseDir: r1.dir });
  ok("E27 run2 ok", r2.code === 0 && !r2.hung);
  const runsRoot = join(r2.wt, ".orca", "artifacts", "runs");
  const entries = existsSync(runsRoot) ? readdirSync(runsRoot) : [];
  eq("E27 exactly one archive folder", entries.length, 1);
  ok("E27 folder named seq-ts", /^0001-\d{8}-\d{6}$/.test(entries[0] ?? ""));
  eq("E27 archived A.md holds the marker", readFileSync(join(runsRoot, entries[0], "A.md"), "utf8"), "RUN1 MARKER\n");
  ok("E27 archived status.js exists", existsSync(join(runsRoot, entries[0], "status.js")));
  ok("E27 flat A.md overwritten by run 2", !/RUN1 MARKER/.test(readFileSync(join(r2.wt, ".orca", "artifacts", "A.md"), "utf8")));
});

// ---------------------------------------------------------------------------
// E28 — chooser defaults & bypass: with previous runs present the flow lists
// them; EOF/Enter/0 starts a NEW run (archive created, no restore); --new
// skips the prompt; dry-run lists read-only and archives nothing.
// ---------------------------------------------------------------------------
scenario("E28 chooser: EOF=new, --new bypass, dry-run lists only", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e28", config: cfg });
  ok("E28 run1 ok (no prompt on empty worktree)", r1.code === 0 && !r1.hung);
  const r2 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir });   // stdin=ignore => EOF => new
  ok("E28 run2 ok (EOF chose new)", r2.code === 0 && !r2.hung);
  ok("E28 run2 listed previous runs", /Previous runs in this worktree:/.test(r2.out + r2.err));
  ok("E28 run2 archived run1", existsSync(join(r2.wt, ".orca", "artifacts", "runs")));
  const r3 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, args: ["--new"] });
  ok("E28 run3 --new ok", r3.code === 0 && !r3.hung);
  ok("E28 run3 no prompt", !/Choose: <n>/.test(r3.out + r3.err));
  const rJunk = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, stdinText: "1x\n" });
  ok("E28 junk input '1x' starts a new run", rJunk.code === 0 && !/resuming|restored/.test(rJunk.out + rJunk.err));
  const before = readdirSync(join(r3.wt, ".orca", "artifacts", "runs")).length;
  const r4 = await runFlow({ name: "e28", config: cfg, reuseDir: r1.dir, args: ["--dry-run"] });
  ok("E28 dry-run lists runs", /Previous runs in this worktree:/.test(r4.out));
  eq("E28 dry-run archives nothing", readdirSync(join(r3.wt, ".orca", "artifacts", "runs")).length, before);
});

// ---------------------------------------------------------------------------
// E28b — chooser: resuming the (current) incomplete run — no archive, no
// restore, the succeeded producer is NOT re-dispatched, run resumes from
// the failed step and completes.
// ---------------------------------------------------------------------------
scenario("E28b resume current incomplete run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e28b", config: cfg, scenario: "chooser-fail-beta.cjs" });
  eq("E28b run1 exit (beta failed)", r1.code, 1);
  const taskCreateAfterRun1 = r1.by("orchestration task-create").length;
  const r2 = await runFlow({ name: "e28b", config: cfg, reuseDir: r1.dir, stdinText: "1\n" });
  ok("E28b run2 ok", r2.code === 0 && !r2.hung);
  ok("E28b chose current", /resuming the current run from "beta"/.test(r2.out + r2.err));
  eq("E28b only beta re-tasked", r2.by("orchestration task-create").length - taskCreateAfterRun1, 1);
  ok("E28b no archive folder", !existsSync(join(r2.wt, ".orca", "artifacts", "runs")));
});

// ---------------------------------------------------------------------------
// E29 — chooser: resuming an ARCHIVED run. Run 1 fails at beta; its flat
// state (with a marker) is archived when run 2 starts fresh; run 3 picks the
// archived entry: run-2 state archived first, run-1 artifacts RESTORED
// (marker back), producer skipped, resume from beta.
// ---------------------------------------------------------------------------
scenario("E29 resume archived run restores and skips producer", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e29", config: cfg, scenario: "chooser-fail-beta.cjs" });
  eq("E29 run1 exit", r1.code, 1);
  // The marker must clear readinessMinBytes (200, cf. E15): the restore path
  // SKIPS the producer, so beta reads this very file — an 11-byte marker
  // would (correctly) be rejected as "too small" and stop the run.
  const run1Marker = "RUN1 STATE\n" + "archived-run marker filler line to clear the readiness minimum\n".repeat(8);
  writeFileSync(join(r1.wt, ".orca", "artifacts", "A.md"), run1Marker);
  const r2 = await runFlow({ name: "e29", config: cfg, reuseDir: r1.dir });   // EOF => new; archives RUN1 STATE
  ok("E29 run2 ok", r2.code === 0 && !r2.hung);
  const taskCreateAfterRun2 = r2.by("orchestration task-create").length;      // 2 more (alpha+beta)
  const r3 = await runFlow({ name: "e29", config: cfg, reuseDir: r1.dir, stdinText: "2\n" }); // 1=current(run2), 2=archived 0001
  ok("E29 run3 ok", r3.code === 0 && !r3.hung);
  ok("E29 restored run 0001", /restored run 0001-\d{8}-\d{6}/.test(r3.out + r3.err));
  eq("E29 flat A.md restored to run-1 state", readFileSync(join(r3.wt, ".orca", "artifacts", "A.md"), "utf8"), run1Marker);
  eq("E29 only beta re-tasked", r3.by("orchestration task-create").length - taskCreateAfterRun2, 1);
  const runsEntries = readdirSync(join(r3.wt, ".orca", "artifacts", "runs"));
  eq("E29 two archive folders (run1 then run2 states)", runsEntries.length, 2);
});

// ---------------------------------------------------------------------------
// E30 — chooser: picking a COMPLETED run notes it and runs fresh (archive of
// the completed state + full re-dispatch from step 1).
// ---------------------------------------------------------------------------
scenario("E30 completed-run choice starts a new run", async () => {
  const cfg = "../test/configs/cold.config.json";
  const r1 = await runFlow({ name: "e30", config: cfg });
  ok("E30 run1 ok", r1.code === 0 && !r1.hung);
  const taskCreateAfterRun1 = r1.by("orchestration task-create").length;      // 2
  const r2 = await runFlow({ name: "e30", config: cfg, reuseDir: r1.dir, stdinText: "1\n" }); // pick (current), completed
  ok("E30 run2 ok", r2.code === 0 && !r2.hung);
  ok("E30 already-completed note", /already completed — starting a new run/.test(r2.out + r2.err));
  eq("E30 full fresh run (both steps re-tasked)", r2.by("orchestration task-create").length - taskCreateAfterRun1, 2);
  eq("E30 completed state archived", readdirSync(join(r2.wt, ".orca", "artifacts", "runs")).length, 1);
});

// ---------------------------------------------------------------------------
// E20 — nudge budget exhaustion: worker_done(succeeded) but no artifact and
// the terminal never complies => exactly nudgeRetries nudges, then the step
// settles FAILED (the artifact file is ground truth, not worker_done).
// ---------------------------------------------------------------------------
scenario("E20 nudge exhausted settles failed", async () => {
  const r = await runFlow({ name: "e20", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-exhaust.cjs", budgetMs: 60000 });
  ok("E20 not hung", !r.hung);
  eq("E20 exit code", r.code, 1);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E20 exactly two nudge texts", textSends.length, 2);
  eq("E20 step failed", r.status?.steps[0]?.status, "failed");
  ok("E20 exhaustion note", /artifact missing after 2 nudge\(s\)/.test(r.status?.steps[0]?.note ?? ""));
});

// ---------------------------------------------------------------------------
// E21 — mid-run nudge: frozen preview + stale heartbeat + missing artifact +
// no worker_done => nudge fires; the recovered worker_done then settles the
// step succeeded. Pins the double-idle-evidence path.
// ---------------------------------------------------------------------------
scenario("E21 nudge mid-run idle recovery", async () => {
  const r = await runFlow({ name: "e21", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-midrun.cjs", budgetMs: 60000 });
  ok("E21 not hung", !r.hung);
  eq("E21 exit code", r.code, 0);
  const textSends = r.by("terminal send").filter((cx) => String(cx.flags.text ?? "").includes("[orca-flow]"));
  eq("E21 exactly one nudge text", textSends.length, 1);
  eq("E21 status overall", r.status?.overall, "succeeded");
  ok("E21 artifact exists", existsSync(join(r.wt, ".orca", "artifacts", "A.md")));
});

// ---------------------------------------------------------------------------
// E22 — parked-prompt safety: a nudge-eligible member parked on a dialog is
// NEVER nudged (zero terminal sends) and keeps the parked semantics (warn +
// hold to the hard cap). The hard safety rule of the nudge feature.
// ---------------------------------------------------------------------------
scenario("E22 parked dialog is never nudged", async () => {
  const r = await runFlow({ name: "e22", config: "../test/configs/nudge-post.config.json",
    scenario: "nudge-parked.cjs", budgetMs: 90000 });
  ok("E22 not hung", !r.hung);
  eq("E22 zero terminal sends", r.by("terminal send").length, 0);
  ok("E22 parked warn present", /PARKED on a permission-rule confirmation/.test(r.out + r.err));
  eq("E22 status overall", r.status?.overall, "still-running");
  ok("E22 exit code (hard cap stop)", r.code === 1);
});

// ---------------------------------------------------------------------------
// E23 — nudgeRetries: 0 disables nudging for the step: done-without-artifact
// settles with the ORIGINAL outcome (legacy) and a "(nudge disabled)" note;
// zero terminal sends. The consumer-side readiness gate remains the net.
// ---------------------------------------------------------------------------
scenario("E23 nudgeRetries 0 disables nudging", async () => {
  const r = await runFlow({ name: "e23", config: "../test/configs/nudge-off.config.json",
    scenario: "nudge-exhaust.cjs", budgetMs: 45000 });
  ok("E23 not hung", !r.hung);
  eq("E23 exit code", r.code, 0);
  eq("E23 zero terminal sends", r.by("terminal send").length, 0);
  eq("E23 status overall", r.status?.overall, "succeeded");
  ok("E23 disabled note", /artifact missing \(nudge disabled\)/.test(r.status?.steps[0]?.note ?? ""));
});

// N3 — default-off: an EMPTY notify template sends nothing and stays silent.
// Baseline pin recorded BEFORE the engine feature lands; it must hold after.
// ---------------------------------------------------------------------------
scenario("N3 notify default-off (empty template: zero sends, zero warns)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n3", config: "../test/configs/cold.config.json",
      notify: { enabled: true, provider: "", url: "", token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 90000 });
    ok("N3 not hung", !r.hung);
    eq("N3 exit code", r.code, 0);
    eq("N3 zero notifications", hook.hits.length, 0);
    ok("N3 no notify output", !/\[notify\]/.test(r.out + r.err));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N1 — happy: every step settlement and the run summary are POSTed to the
// webhook in order, with the right text; dry-run announces notify state and
// sends nothing.
// ---------------------------------------------------------------------------
scenario("N1 notify happy (2 step + 1 run POSTs, dry-run sends nothing)", async () => {
  const hook = await recordHook();
  try {
    const cfg = { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] };
    const dry = await runFlow({ name: "n1dry", config: "../test/configs/cold.config.json", args: ["--dry-run"], notify: cfg, budgetMs: 30000 });
    eq("N1 dry-run exit", dry.code, 0);
    ok("N1 dry-run announces notify", /Notifications: on \(slack, events: step,run\)/.test(dry.out));
    eq("N1 dry-run sent nothing", hook.hits.length, 0);

    const r = await runFlow({ name: "n1", config: "../test/configs/cold.config.json", notify: cfg, budgetMs: 90000 });
    ok("N1 not hung", !r.hung);
    eq("N1 exit code", r.code, 0);
    eq("N1 three notifications (2 steps + run)", hook.hits.length, 3);
    ok("N1 alpha step text", /Step "Alpha" SUCCEEDED in .+ \(attempt 1\) -> \.orca\/artifacts\/A\.md/.test(hook.hits[0]?.body?.text ?? ""));
    ok("N1 beta step text", /Step "Beta" SUCCEEDED/.test(hook.hits[1]?.body?.text ?? ""));
    ok("N1 run text", /Run run-\d+ SUCCEEDED in .+ — "test objective"/.test(hook.hits[2]?.body?.text ?? ""));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N2 — degradation: a dead webhook warns exactly once (latch), never blocks
// and never changes the outcome.
// ---------------------------------------------------------------------------
scenario("N2 notify degradation (dead webhook: one warn, run unaffected)", async () => {
  const r = await runFlow({ name: "n2", config: "../test/configs/cold.config.json",
    notify: { enabled: true, provider: "slack", url: "http://127.0.0.1:1/hook", token: "", chatId: "", to: "", events: ["step", "run"] },
    budgetMs: 90000 });
  ok("N2 not hung", !r.hung);
  eq("N2 exit code", r.code, 0);
  const warns = (r.out + r.err).match(/\[notify\] disabled: delivery failed/g) || [];
  eq("N2 exactly one delivery warn (latch works)", warns.length, 1);
  eq("N2 pipeline unaffected (both steps ok)", (r.out + r.err).match(/\[ok\] /g)?.length, 2);
  eq("N2 status overall", r.status?.overall, "succeeded");
});

// ---------------------------------------------------------------------------
// N4 — the still-running chat hint must point PAST the live worker (re-
// dispatching it is the double-dispatch the kit forbids), matching the
// console's advice; a FAILED step resumes from itself (unpinned — shares notifyRun with the pinned path).
// ---------------------------------------------------------------------------
scenario("N4 notify still-running hint (points at the NEXT step)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n4", config: "../test/configs/hang.config.json", scenario: "hang.cjs",
      notify: { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 45000 });
    eq("N4 exit code", r.code, 1);
    eq("N4 two notifications (alpha step + run)", hook.hits.length, 2);
    const runText = hook.hits[1]?.body?.text ?? "";
    ok("N4 run names the stuck step", /stuck at: alpha/.test(runText));
    ok("N4 hint points past the live worker", /--from beta/.test(runText));
    ok("N4 never suggests re-dispatching the live worker", !/--from alpha/.test(runText));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// N5 — mixed parallel group (one live worker + one failed sibling): the chat
// hint must point past the whole group, never at the failed sibling — re-
// running its group would re-dispatch the live worker.
// ---------------------------------------------------------------------------
scenario("N5 notify mixed group (hint points past the live group)", async () => {
  const hook = await recordHook();
  try {
    const r = await runFlow({ name: "n5", config: "../test/configs/parallel-hang.config.json", scenario: "parallel-mixed.cjs",
      notify: { enabled: true, provider: "slack", url: hook.url, token: "", chatId: "", to: "", events: ["step", "run"] },
      budgetMs: 45000 });
    eq("N5 exit code", r.code, 1);
    eq("N5 three notifications (right failed, left still-running, run)", hook.hits.length, 3);
    const runText = hook.hits[2]?.body?.text ?? "";
    ok("N5 run names the live worker as stuck", /stuck at: left/.test(runText));
    ok("N5 hint points past the group", /--from join/.test(runText));
    ok("N5 never suggests re-running the failed sibling's group", !/--from right/.test(runText));
  } finally { await hook.close(); }
});

// ---------------------------------------------------------------------------
// F — fast validation: shipped configs + CLI/config guards. These die (or
// dry-run) before any agent work; budgets are tight.
// ---------------------------------------------------------------------------
scenario("F1 shipped configs dry-run cleanly", async () => {
  for (const cfg of [null, "fixbug.config.json", "cr.config.json",
    "workflow-template/sdlc.config.json", "workflow-template/fixbug.config.json", "workflow-template/cr.config.json"]) {
    const label = cfg || "flow.config.json (default)";
    const r = await runFlow({ name: "f1", config: cfg, args: ["--dry-run"], objective: "suite smoke", budgetMs: 30000 });
    ok(`F1 ${label} not hung`, !r.hung);
    eq(`F1 ${label} exit`, r.code, 0);
    ok(`F1 ${label} prints dry-run banner`, /Dry-run — no agents called/.test(r.out));
    ok(`F1 ${label} lists steps`, /^\s+1\. /m.test(r.out));
  }
});

// fixtures are deliberately defaults-free: they die during load-time validation, before any timing applies
const BAD_CONFIGS = [
  ["F2 unknown parallelWith target", "bad-parallel-unknown.json", /parallelWith "ghost" is not a known step id/],
  ["F3 chained parallelWith", "bad-parallel-chain.json", /parallelWith chains are not allowed/],
  ["F4 non-contiguous parallel group", "bad-parallel-gap.json", /must be contiguous/],
  ["F5 member reads its target", "bad-parallel-reads.json", /dependent steps cannot run in parallel with what they read/],
  ["F10 forward read", "bad-forward-read.json", /reads "late" which has not run yet — reorder the pipeline/],
  ["F11 read of a writes-less step", "bad-reads-no-writes.json", /reads "ghost" which has no "writes" — nothing to read/],
  ["F12 negative nudgeRetries", "bad-nudge-negative.json", /nudgeRetries must be a non-negative integer/],
  ["F12b zero nudgeTimeoutMs", "bad-nudge-zero-timeout.json", /nudgeTimeoutMs must be a positive integer/],
  ["F13 negative step maxRetries", "bad-retry-per-step.json", /step "reviewer": maxRetries must be a non-negative integer \(got -1\)/],
  ["F13b fractional global maxRetries", "bad-retry-global.json", /config: maxRetries must be a non-negative integer \(got 1.5\)/],
];
for (const [name, file, re] of BAD_CONFIGS) {
  scenario(name, async () => {
    const r = await runFlow({ name: file.replace(".json", ""), config: `../test/configs/${file}`, objective: "validate", budgetMs: 15000 });
    ok(`${name} not hung`, !r.hung);
    eq(`${name} exit code`, r.code, 1);
    ok(`${name} message`, re.test(r.out + r.err));
  });
}

scenario("F6 --grill-me and --no-grill-me are mutually exclusive", async () => {
  const r = await runFlow({ name: "f6", args: ["--grill-me", "--no-grill-me"], objective: "x", budgetMs: 15000 });
  ok("F6 not hung", !r.hung);
  eq("F6 exit code", r.code, 1);
  ok("F6 message", /mutually exclusive/.test(r.out + r.err));
});

scenario("F7 --status-preview refuses real-run mixes", async () => {
  const r = await runFlow({ name: "f7", args: ["--status-preview"], objective: "build it", budgetMs: 15000 });
  ok("F7 not hung", !r.hung);
  eq("F7 exit code", r.code, 1);
  ok("F7 message", /renders a SAMPLE status page/.test(r.out + r.err));
});

scenario("F8 objective is required for real runs", async () => {
  const r = await runFlow({ name: "f8", objective: "", budgetMs: 15000 });
  ok("F8 not hung", !r.hung);
  eq("F8 exit code", r.code, 1);
  ok("F8 message", /An objective is required/.test(r.out + r.err));
});

scenario("F9 --from must name an enabled step", async () => {
  const r = await runFlow({ name: "f9", args: ["--from", "ghost"], objective: "x", budgetMs: 15000 });
  ok("F9 not hung", !r.hung);
  eq("F9 exit code", r.code, 1);
  ok("F9 message", /is not among the enabled steps/.test(r.out + r.err));
});

// ---------------------------------------------------------------------------
// I — installer (bin/init.mjs, the npx entry). I1 runs it for real in an empty
// temp "user project" — the exact repro of the v2.0.0 ENOENT (the whitelist
// gained .orca/workflow-template/* files but only .orca itself was mkdir'd).
// I2 guards the documented invariant: FILES must mirror package.json "files"
// (a drift either corrupts the package or makes init die on a missing source).
// ---------------------------------------------------------------------------
async function runInit({ name, args = [], budgetMs = 15000 }) {
  const dir = mkdtempSync(join(tmpdir(), `orca-init-${name}-`));
  dirsOfCurrentScenario.push(dir);
  const child = spawn(NODE, [join(REPO, "bin", "init.mjs"), ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; let err = ""; let hung = false;
  const timer = setTimeout(() => { hung = true; hungInCurrentScenario = true; child.kill(); }, budgetMs);
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  const code = await new Promise((r) => child.on("exit", (c) => r(c)));
  clearTimeout(timer);
  return { code, out, err, hung, dir };
}

scenario("I1 installer (empty project: every whitelisted file lands)", async () => {
  const r = await runInit({ name: "i1" });
  ok("I1 not hung", !r.hung);
  eq("I1 exit code", r.code, 0);
  ok("I1 no copy failure", !/copy failed/.test(r.out + r.err), (r.out + r.err).trim());
  for (const f of ["flow.mjs", "flow.config.json", "fixbug.config.json", "cr.config.json", "CONFIGURATION.md", "README.md", "notify.json",
    "workflow-template/README.md", "workflow-template/sdlc.config.json", "workflow-template/fixbug.config.json", "workflow-template/cr.config.json"])
    ok(`I1 installed .orca/${f}`, existsSync(join(r.dir, ".orca", f)));
  ok("I1 installed orca.yaml", existsSync(join(r.dir, "orca.yaml")));
  ok("I1 .gitignore got the artifacts line", readFileSync(join(r.dir, ".gitignore"), "utf8").includes(".orca/artifacts/"));
});

scenario("I2 FILES whitelist mirrors package.json files", async () => {
  const src = readFileSync(join(REPO, "bin", "init.mjs"), "utf8");
  const files = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).files
    .filter((f) => f !== "bin/").sort();
  const whitelist = src.slice(src.indexOf("const FILES = ["), src.indexOf("];", src.indexOf("const FILES = [")))
    .match(/"[^"]+"/g)?.map((s) => s.slice(1, -1)).sort() ?? [];
  eq("I2 whitelist matches package.json files", whitelist, files);
});

// ---------------------------------------------------------------------------
(async () => {
  const t0 = Date.now();
  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    console.log(`\n# ${s.name}`);
    const failedBefore = failed;
    dirsOfCurrentScenario = [];
    hungInCurrentScenario = false;
    try { await s.fn(); } catch (e) { failed++; total++; console.error("FAIL -", s.name, "threw:", e.message); }
    for (const d of dirsOfCurrentScenario) {
      if (failed > failedBefore || hungInCurrentScenario) console.error(`[harness] kept ${d} for inspection`);
      else { try { rmSync(d, { recursive: true, force: true }); } catch {} }
    }
  }
  if (only && !total) { console.error(`FAIL - --only "${only}" matched no scenario`); process.exit(1); }
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${total - failed}/${total} assertions passed in ${dt}s`);
  if (failed) console.error(`${failed} FAILURE(S)`);
  process.exitCode = failed ? 1 : 0;
})();
