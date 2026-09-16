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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
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
async function runFlow({ name, config, scenario: scenarioFile = "default.cjs", args = [], objective = "test objective", seedArtifacts = [], budgetMs = 90000, notify = null }) {
  const dir = mkdtempSync(join(tmpdir(), `orca-flow-${name}-`));
  dirsOfCurrentScenario.push(dir);
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
  env.ORCA_FLOW_WORKTREE = "name:testlab";
  // notify template, when given, is handed to the child via its file's path — the
  // only source, since every inherited ORCA_* key was stripped above.
  if (notify) env.ORCA_FLOW_NOTIFY_FILE = join(dir, "notify.json");
  env.USERPROFILE = home;
  env.HOME = home;
  const argv = [FLOW, ...args, "--no-open-status"];
  if (config) argv.push("--config", config);
  if (objective) argv.push(objective);
  const child = spawn(NODE, argv, { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
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
  ok("E7 fail jump logged", /\[fail\] Reviewer FAILED -> back to "Coder" \(attempt 1\/1\)/.test(r.out + r.err));
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
  const seed = [{ file: "A.md", text: "# Alpha output\nprior run artifact\n" }];
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
  const dt = Math.round((Date.now() - t0) / 1000);
  console.log(`\n${total - failed}/${total} assertions passed in ${dt}s`);
  if (failed) console.error(`${failed} FAILURE(S)`);
  process.exitCode = failed ? 1 : 0;
})();
