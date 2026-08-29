#!/usr/bin/env node
// .orca/flow.mjs — SDLC pipeline orchestrator for Orca ADE
// Cross-platform (Windows/macOS/Linux). Needs only Node (already required by Orca).
// =============================================================================
// The pipeline is DEFINED IN flow.config.json, not hard-coded here.
// Enable/disable steps via "enabled". A disabled step is auto-removed from
// later steps' "reads".
//
// Usage:
//   node .orca/flow.mjs "Description of the feature / objective"
//
// Resume from a step (skip earlier steps):
//   node .orca/flow.mjs --from coding "..."
//
// Run only a subset of steps:
//   node .orca/flow.mjs --only planning,architecture "..."
//
// Preview the pipeline WITHOUT calling agents (dry-run):
//   node .orca/flow.mjs --dry-run "..."
//
// Override one step's agent for this run:
//   node .orca/flow.mjs --agent coding=claude "..."
//
// Run a DIFFERENT pipeline config (e.g. the bug-fix flow in fixbug.config.json):
//   node .orca/flow.mjs --config fixbug.config.json "<bug description>"
//
// Step timeouts: `timeoutMs` = max worker SILENCE (no terminal output, no
// heartbeat) before the step is considered hung; `hardTimeoutMs` (default 4x
// timeoutMs) = absolute cap — on hit the worker's terminal is left open and
// the flow stops with a --from resume hint (outcome=still-running).
// =============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[orca-flow]", ...a);
const warn = (...a) => console.warn("[orca-flow]", ...a);
const die = (m) => { console.error("[orca-flow] ERROR:", m); process.exit(1); };

// --- Parse argv: flags + objective ---
const argv = process.argv.slice(2);
const opt = { from: null, only: null, dryRun: false, config: null, agentOverrides: {} };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--from") opt.from = argv[++i];
  else if (a === "--only") opt.only = argv[++i].split(",").map((s) => s.trim());
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--config") opt.config = argv[++i];
  else if (a === "--agent") {
    const [step, ag] = argv[++i].split("=");
    if (step && ag) opt.agentOverrides[step] = ag;
  } else rest.push(a);
}
const objective = rest.join(" ").trim();
if (!objective && !opt.dryRun)
  die('An objective is required, e.g.: node .orca/flow.mjs "Build a login page"');

// --- Load config ---
const CONFIG_FILE = opt.config || "flow.config.json";
let cfg;
try { cfg = JSON.parse(readFileSync(join(HERE, CONFIG_FILE), "utf8")); }
catch (e) { die(`Could not read ${CONFIG_FILE}: ${e.message}`); }

const ART_DIR = cfg.artifactsDir || ".orca/artifacts";
const MAX_RETRIES = cfg.maxRetries ?? 2;
const DEFAULT_TIMEOUT = cfg.defaults?.timeoutMs ?? 900000;
const outPath = (file) => `${ART_DIR}/${file}`;

// --- Normalize pipeline: keep enabled steps, build id->step map ---
const allSteps = (cfg.pipeline || []).filter((s) => s && s.id);
const byId = Object.fromEntries(allSteps.map((s) => [s.id, s]));

// enabled=false => skip. --only limits the set. --from drops steps before the mark.
function isEnabled(step) {
  if (step.enabled === false) return false;
  if (opt.only) return opt.only.includes(step.id);
  return true;
}
let steps = allSteps.filter(isEnabled);
if (opt.from) {
  const idx = steps.findIndex((s) => s.id === opt.from);
  if (idx < 0) die(`--from "${opt.from}" is not among the enabled steps.`);
  steps = steps.slice(idx);
}
if (steps.length === 0) die("No steps to run (all skipped?).");

const enabledIds = new Set(steps.map((s) => s.id));

// A step's reads. Steps in this run always count. Steps NOT part of this run
// (dropped by --from/--only, or disabled) still count when their artifact file
// already exists in the worktree — that is the RESUME case: `--from coding`
// must still point the coder at the design docs produced by an earlier run.
function effectiveReads(step) {
  return (step.reads || []).filter((id) => {
    if (!byId[id]) return false;
    if (enabledIds.has(id)) return true;
    const p = resolveWorktreePath();
    return p ? existsSync(join(p, ART_DIR, byId[id].writes)) : false;
  });
}

// Substitute {out} and {reads} in the spec
function renderSpec(step) {
  const reads = effectiveReads(step);
  const readList = reads.length
    ? reads.map((id) => `${byId[id].title} (${outPath(byId[id].writes)})`).join(", ")
    : "(no prior input — start from the objective)";
  const objectiveLine = `OVERALL OBJECTIVE: ${objective}\n\n`;
  return objectiveLine + (step.spec || "")
    .replaceAll("{out}", outPath(step.writes))
    .replaceAll("{reads}", readList);
}

// --- Orca CLI (argv-safe, no shell to avoid mangling special characters) ---
const IS_WIN = process.platform === "win32";
function resolveOrca() {
  const bases = process.env.ORCA_CLI_COMMAND
    ? [process.env.ORCA_CLI_COMMAND] : ["orca", "orca-dev", "orca-ide"];
  const cands = IS_WIN
    ? bases.flatMap((b) => (b.includes(".") ? [b] : [`${b}.cmd`, `${b}.exe`, b])) : bases;
  for (const c of cands) {
    const p = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (!p.error) return c;
  }
  die("Could not find the orca CLI. Set ORCA_CLI_COMMAND.");
}
let ORCA = null;
function orca(args, { timeoutMs } = {}) {
  const full = args.includes("--json") ? args : [...args, "--json"];
  const r = spawnSync(ORCA, full, {
    encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const raw = (r.stdout || "").trim();
  let json = null;
  for (const line of raw.split(/\r?\n/).reverse()) {
    const s = line.trim();
    if (s.startsWith("{") || s.startsWith("[")) { try { json = JSON.parse(s); break; } catch {} }
  }
  if (!json && raw) { try { json = JSON.parse(raw); } catch {} }
  return { ok: r.status === 0, json, raw, stderr: (r.stderr || "").trim() };
}
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; };
// This Orca build wraps payloads in result.{run,task,...}. Unwrap first.
const res = (j) => (j && j.result) ? j.result : (j || {});
let RUN_ID = null;               // result.run.id from run-create; passed as --run everywhere
const agentOf = (step) => opt.agentOverrides[step.id] || step.agent;
const timeoutOf = (step) => step.timeoutMs || DEFAULT_TIMEOUT;

// Blocking sleep (Node allows Atomics.wait on the main thread).
function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// WHY THE MANUAL DISPATCH PATH: every Orca injection path (worker-start
// --agent / --terminal, dispatch --inject) waits ~15s at the dispatch_input
// stage for an ACCEPTANCE signal that only agents LAUNCHED BY ORCA can send —
// the agent-hook chain (UserPromptSubmit hook -> claude-hook.cmd -> local HTTP
// POST with a per-dispatch launchToken). A TUI we start via `terminal create`
// receives and processes the prompt fine, but can never produce that signal,
// so the dispatch is failed with agent_prompt_stalled and its capability
// revoked (verified: the agent finishes the work, then its worker_done is
// rejected). Therefore we use the documented low-level recipe:
//   1. warm the agent TUI ourselves (terminal create + quiet-detect),
//   2. create a TRACKING dispatch WITHOUT --inject (no acceptance window),
//   3. fetch the exact worker preamble via --dry-run --return-preamble,
//   4. substitute the real dispatch id (dry-run text uses "ctx_dryrun"),
//   5. deliver with `terminal send --text ... --enter`.
// Verified end-to-end: prompt delivered, worker_done accepted, task completed.
// Orca's own cold launch (worker-start --agent) stays as a fallback for
// machines where the TUI boots inside Orca's acceptance window.
const START_RETRIES = cfg.defaults?.startRetries ?? 2;
const START_RETRY_DELAY_MS = cfg.defaults?.startRetryDelayMs ?? 4000;
const WARMUP_TIMEOUT_MS = cfg.defaults?.warmupTimeoutMs ?? 240000;
// Where agents run. IMPORTANT: "current"/"active" resolve by the INVOKING
// CWD for `terminal create` (strictly) — running flow.mjs from a folder that
// is not itself an Orca worktree (e.g. this config-only folder) fails with
// selector_not_found. So we resolve a CONCRETE selector once at startup:
// defaults.worktree if given, else the CWD's worktree, else we stop and tell
// the user to pin one (e.g. "name:lab2").
const WT_CFG = cfg.defaults?.worktree || null;
let WT = null;
function resolveWorktree(soft = false) {
  if (WT) return WT;
  if (WT_CFG) { WT = WT_CFG; return WT; }
  const w = orca(["worktree", "current"]);
  const entry = pick(res(w.json), ["worktree"]) || res(w.json);
  const p = pick(entry, ["path"]);
  if (w.ok && p) { WT = `path:${p}`; return WT; }
  if (soft) return null;
  die('Could not resolve the target worktree (CWD is not inside an Orca-managed worktree). ' +
      'Set "defaults": { "worktree": "name:<displayName>" } (or "path:<dir>") in flow.config.json.');
}
// Filesystem path of the worktree (agents run THERE, so artifacts live there —
// not necessarily next to this config). Null until resolvable.
let WT_PATH = null;
function resolveWorktreePath(soft = false) {
  if (WT_PATH != null) return WT_PATH;
  const sel = resolveWorktree(soft);
  if (!sel) return null;
  if (sel.startsWith("path:")) WT_PATH = sel.slice("path:".length);
  else {
    const w = orca(["worktree", "show", "--worktree", sel]);
    WT_PATH = pick(res(w.json).worktree || {}, ["path"]) || null;
  }
  return WT_PATH;
}

function warmTerminal(agent) {
  const startedAt = Date.now();
  const c = orca(["terminal", "create", "--worktree", resolveWorktree(), "--command", agent]);
  const cr = res(c.json);
  const handle = pick(cr, ["handle", "terminalHandle"]) || pick(cr.terminal || {}, ["handle"]);
  if (!c.ok || !handle) {
    warn(`terminal create ('${agent}') failed: ${c.stderr || c.raw || "no handle"}; cold-starting instead.`);
    return null;
  }
  // `terminal wait --for tui-idle` is satisfied trivially while a TUI is still
  // BOOTING (no active request = idle), so it cannot prove input readiness.
  // Instead detect readiness from output activity: the TUI must have rendered
  // (lastOutputAt moved) and then stayed quiet for QUIET_MS — at that point
  // the input box is up and an injected prompt is consumed immediately.
  const QUIET_MS = 8000, MIN_UPTIME_MS = 12000, POLL_MS = 3000;
  let lastOut = -1, quietSince = Date.now();
  while (Date.now() - startedAt < WARMUP_TIMEOUT_MS) {
    sleepMs(POLL_MS);
    const s = orca(["terminal", "show", "--terminal", handle]);
    const out = pick(pick(res(s.json), ["terminal"]) || {}, ["lastOutputAt"]) || 0;
    if (out !== lastOut) { lastOut = out; quietSince = Date.now(); }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= MIN_UPTIME_MS && Date.now() - quietSince >= QUIET_MS) {
      log(`  warmed ${agent} terminal ${handle} (${Math.round(elapsed / 1000)}s)`);
      return handle;
    }
  }
  warn(`agent '${agent}' TUI not ready within ${WARMUP_TIMEOUT_MS}ms; cold-starting instead.`);
  orca(["terminal", "close", "--terminal", handle]);
  return null;
}

// Manual path: returns { dispatchId, terminal } or null. See the comment
// block above for why we cannot use worker-start's injection on this setup.
function manualStart(step, taskId) {
  const term = warmTerminal(agentOf(step));
  if (!term) return null;

  // Tracking dispatch WITHOUT --inject: no injection, no acceptance window.
  const d = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", RUN_ID]);
  const dr = res(d.json);
  const dispatchId = pick(pick(dr, ["dispatch"]) || {}, ["id"]) || pick(dr, ["dispatchId", "dispatch_id"]);
  if (!d.ok || !dispatchId) {
    warn(`tracking dispatch '${step.title}' failed: ${d.stderr || d.raw}`);
    orca(["terminal", "close", "--terminal", term]);
    return null;
  }

  // Exact worker preamble (includes the TASK spec) with a placeholder id.
  const p = orca(["orchestration", "dispatch", "--task", taskId, "--to", term, "--run", RUN_ID,
    "--dry-run", "--return-preamble"]);
  const preamble = pick(res(p.json), ["preamble"]);
  if (!p.ok || !preamble) {
    warn(`preamble fetch '${step.title}' failed: ${p.stderr || p.raw}`);
    orca(["terminal", "close", "--terminal", term]);
    return null;
  }

  const s = orca(["terminal", "send", "--terminal", term, "--text",
    preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
  if (!s.ok) {
    warn(`terminal send '${step.title}' failed: ${s.stderr || s.raw}`);
    orca(["terminal", "close", "--terminal", term]);
    return null;
  }

  // A send can be silently DROPPED: TUIs may flush pending input when they
  // finish booting and switch to their input view (seen with opencode —
  // warmed quiet, paste sent, the welcome screen never changed and the
  // worker never started). Verify consumption via the rendered preview and
  // re-send when nothing happened. Preview unavailable => assume delivered
  // (older hosts) rather than block a healthy worker.
  const START_GRACE_MS = cfg.defaults?.startGraceMs ?? 90000;
  const SEND_ATTEMPTS = cfg.defaults?.sendAttempts ?? 3;
  const previewOf = (h) =>
    pick(pick(res(orca(["terminal", "show", "--terminal", h]).json), ["terminal"]) || {}, ["preview"]) ?? null;
  const before = previewOf(term);
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    const deadline = Date.now() + START_GRACE_MS;
    while (Date.now() < deadline) {
      sleepMs(4000);
      const pv = previewOf(term);
      if (pv == null || before == null || pv !== before) return { dispatchId, terminal: term };
    }
    if (attempt < SEND_ATTEMPTS) {
      warn(`no sign the '${step.title}' prompt was consumed; re-sending (${attempt + 1}/${SEND_ATTEMPTS})`);
      const s2 = orca(["terminal", "send", "--terminal", term, "--text",
        preamble.split("ctx_dryrun").join(dispatchId), "--enter"]);
      if (!s2.ok) { warn(`re-send '${step.title}' failed: ${s2.stderr || s2.raw}`); break; }
    }
  }
  warn(`prompt for '${step.title}' was not consumed after ${SEND_ATTEMPTS} attempt(s); cold-starting instead.`);
  orca(["terminal", "close", "--terminal", term]);
  return null;
}

// Fallback: Orca-managed cold launch via worker-start --agent. Works only
// where the agent TUI boots within Orca's short dispatch_input window.
function coldStart(step, taskId) {
  let retryOf = null;
  for (let attempt = 0; attempt <= START_RETRIES; attempt++) {
    const args = ["orchestration", "worker-start", "--task", taskId, "--run", RUN_ID,
      "--worktree", resolveWorktree(), "--agent", agentOf(step)];
    if (step.model) args.push("--model", step.model);
    if (step.effort) args.push("--effort", step.effort);
    if (step.startTimeoutMs) args.push("--timeout-ms", String(step.startTimeoutMs));
    if (retryOf) args.push("--retry-of", retryOf);

    const r = orca(args);
    const result = res(r.json);
    const dispatchId = pick(result, ["dispatchId", "dispatch_id"]);
    const state = pick(result, ["state"]);
    if (r.ok && (state === "ready" || !state)) return { dispatchId, terminal: null };

    const lastError = pick(result, ["lastError"]) || r.stderr || "unknown error";
    const failedStage = pick(result, ["failedStage", "stage"]);
    if (dispatchId && state === "failed") {
      orca(["orchestration", "worker-release", "--dispatch", dispatchId]);
    }
    if (attempt < START_RETRIES) {
      warn(`worker-start '${step.title}' not ready (stage=${failedStage}, error=${lastError}). ` +
           `Retrying via --retry-of (attempt ${attempt + 1}/${START_RETRIES})...`);
      retryOf = dispatchId || retryOf;
      sleepMs(START_RETRY_DELAY_MS);
      continue;
    }
    die(`worker-start '${step.title}' failed after ${attempt + 1} attempt(s): ` +
        `stage=${failedStage} error=${lastError}. Raw: ${r.raw || r.stderr}`);
  }
}

function startWorker(step, taskId) {
  return manualStart(step, taskId) || coldStart(step, taskId);
}

// =============================================================================
// DRY-RUN: print the plan and exit
// =============================================================================
function printPlan() {
  log(`Config: ${CONFIG_FILE}${opt.config ? "" : " (default)"}`);
  log(`Worktree: ${WT_CFG || "current (auto-resolved at start)"}`);
  log("Pipeline to run (in order):");
  steps.forEach((s, i) => {
    const reads = effectiveReads(s);
    const flags = [];
    if (s.onFailGoto && enabledIds.has(s.onFailGoto)) flags.push(`onFail->${s.onFailGoto}`);
    if (s.gate) flags.push("gate");
    console.log(
      `  ${i + 1}. ${s.title.padEnd(26)} agent=${agentOf(s).padEnd(9)} ` +
      `reads=[${reads.join(", ") || "-"}] writes=${s.writes}` +
      (flags.length ? `  {${flags.join(", ")}}` : "")
    );
  });
  const skipped = allSteps.filter((s) => !enabledIds.has(s.id)).map((s) => s.id);
  if (skipped.length) log(`Skipped: ${skipped.join(", ")}`);
}
// Resolve the CLI + concrete worktree BEFORE planning: read lists must see
// artifacts already on disk from earlier runs (--from resume), and the
// artifacts dir lives in the WORKTREE, not necessarily beside this config.
// Soft mode (dry-run) degrades to run-scope reads if the runtime is down.
ORCA = resolveOrca();
resolveWorktree(opt.dryRun);
resolveWorktreePath(opt.dryRun);
printPlan();
if (opt.dryRun) { log("Dry-run — no agents called."); process.exit(0); }

// =============================================================================
// Execution
// =============================================================================
resolveWorktree();          // hard-fail here if still unresolved
const WT_DIR = resolveWorktreePath();
mkdirSync(join(WT_DIR || ".", ART_DIR), { recursive: true });
if (!orca(["status"]).ok) die("Orca runtime not ready (orca status failed).");

log(`Creating Run: ${objective}`);
const runResp = orca(["orchestration", "run-create", "--objective", objective]);
if (!runResp.ok) die(`run-create failed: ${runResp.stderr || runResp.raw}`);
RUN_ID = pick(res(runResp.json).run || {}, ["id"]) || pick(res(runResp.json), ["runId", "run_id"]);
if (!RUN_ID) die(`Could not read Run ID from run-create. Output: ${runResp.raw}`);
log(`Run: ${RUN_ID}`);

// Create a task per step, keep taskId for reuse on retries
const taskIds = {};
function ensureTask(step) {
  if (taskIds[step.id]) return taskIds[step.id];
  // Title becomes the first line of the spec (this build has no --task-title flag).
  const spec = `# ${step.title}\n\n${renderSpec(step)}`;
  const r = orca(["orchestration", "task-create", "--run", RUN_ID, "--spec", spec]);
  const id = pick(res(r.json).task || {}, ["id"]) || pick(res(r.json), ["taskId", "task_id", "id"]);
  if (!id) die(`task-create '${step.title}' returned no taskId. Output: ${r.raw || r.stderr}`);
  taskIds[step.id] = id;
  return id;
}

// The outcome of a settled worker: worker_done messages carry it inside the
// `payload` JSON (string or object), not as a top-level field.
function outcomeOf(done) {
  if (!done) return null;
  let o = pick(done, ["outcome", "result"]);
  if (!o && done.payload != null) {
    let p = done.payload;
    if (typeof p === "string") { try { p = JSON.parse(p); } catch { p = null; } }
    o = pick(p || {}, ["outcome", "result"]);
  }
  return o || null;
}

// Liveness + settlement of the worker started for `taskId`, polled between
// wait slices. A healthy agent (e.g. a full coding pass) regularly runs LONGER
// than any fixed wait budget, so an expired wait is NOT a failure signal.
// Freshness: the terminal's RENDERED PREVIEW changing (TUIs redraw their
// content constantly while working — and, crucially, an IDLE TUI also ticks
// lastOutputAt via background repaints, so the timestamp alone CANNOT
// distinguish "busy" from "sitting at the welcome screen"). Heartbeat /
// lastOutputAt serve as fallback when no preview is available. Settlement:
// dispatch.status failed => "failed"; completed => the task record's outcome.
function workerVitals(taskId, terminal, dispatchId) {
  const v = { status: null, settled: false, outcome: null, lastBusyMs: 0, preview: null };
  const d = orca(["orchestration", "dispatch-show", "--task", taskId]);
  const dd = pick(res(d.json), ["dispatch"]) || {};
  v.status = pick(dd, ["status"]);
  const beat = pick(dd, ["last_heartbeat_at"]);
  if (beat) {
    const norm = beat.includes("T") ? beat : beat.replace(" ", "T") + (beat.endsWith("Z") ? "" : "Z");
    const t = Date.parse(norm);
    if (!Number.isNaN(t)) v.lastBusyMs = t;
  }
  let tinfo = null;
  if (terminal) {
    tinfo = pick(res(orca(["terminal", "show", "--terminal", terminal]).json), ["terminal"]) || {};
  } else if (dispatchId) {
    tinfo = pick(res(orca(["orchestration", "worker-show", "--dispatch", dispatchId]).json), ["terminal"]) || {};
  }
  v.lastBusyMs = Math.max(v.lastBusyMs, pick(tinfo, ["lastOutputAt"]) || 0);
  v.preview = pick(tinfo, ["preview"]) ?? null;
  if (v.status === "failed") { v.settled = true; v.outcome = "failed"; }
  else if (/^(completed|settled|done)$/.test(v.status || "")) {
    // Worker finished without our wait seeing worker_done (e.g. it landed in
    // a delivery we already processed). Recover the outcome from the task.
    v.settled = true;
    const tl = orca(["orchestration", "task-list", "--run", RUN_ID]);
    const t = (pick(res(tl.json), ["tasks"]) || []).find((x) => x.id === taskId);
    let r = t && t.result;
    if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
    v.outcome = pick(r || {}, ["outcome", "result"]) || "succeeded";
  }
  return v;
}

// Start the worker, then wait for worker_done — in SLICES, verifying between
// slices that the worker is still alive. One fixed --wait cannot work: it
// turns "agent slower than the budget" into a false outcome=unknown while the
// agent is still working. Semantics after this fix:
//   timeoutMs (per step / defaults) = max SILENCE before giving up on a worker
//   hardTimeoutMs (default 4x timeoutMs) = cap even for a busy-but-endless
//   worker; on hit, the terminal is LEFT OPEN and the flow stops with a
//   resume hint (outcome=still-running).
// Returns { outcome, note, terminal }.
function runStep(step) {
  const taskId = ensureTask(step);
  log(`> ${step.title}  (agent=${agentOf(step)}, task=${taskId})`);
  const { dispatchId, terminal } = startWorker(step, taskId);

  const maxIdleMs = timeoutOf(step);
  const hardCapMs = step.hardTimeoutMs ?? cfg.defaults?.hardTimeoutMs ?? 4 * maxIdleMs;
  const SLICE_MS = Math.min(120000, maxIdleMs);
  const startedAt = Date.now();
  let lastBusy = Date.now();
  let lastPreview;                 // undefined = not observed yet (baseline)
  let done = null, note = "";
  while (true) {
    const wait = orca(["orchestration", "check", "--run", RUN_ID, "--wait",
      "--types", "worker_done,escalation,question", "--timeout-ms", String(SLICE_MS)],
      { timeoutMs: SLICE_MS + 60000 });
    const d = res(wait.json);
    const did = pick(d, ["deliveryId", "delivery_id"]) ?? pick(d.delivery || {}, ["id"]);
    const msgs = pick(d, ["messages", "msgs"]) || [];
    done = msgs.find((m) => pick(m, ["type"]) === "worker_done") || null;
    if (did) orca(["orchestration", "check", "--run", RUN_ID, "--ack", did]);
    if (done) break;
    // Surface questions/escalations, but they don't settle the step.
    for (const m of msgs) {
      const ty = pick(m, ["type"]);
      if (ty === "question" || ty === "escalation")
        log(`  [${ty}] ${pick(m, ["subject"]) || ""}`);
    }

    const v = workerVitals(taskId, terminal, dispatchId);
    if (v.settled) {
      // Drain any pending worker_done delivery first — both to prefer the
      // message's own payload and so it cannot leak into the next step's
      // wait (a bound Run replays unacknowledged deliveries).
      const drain = orca(["orchestration", "check", "--run", RUN_ID, "--types", "worker_done"]);
      const dr = res(drain.json);
      const drid = pick(dr, ["deliveryId", "delivery_id"]) ?? pick(dr.delivery || {}, ["id"]);
      const drained = (pick(dr, ["messages", "msgs"]) || []).find((m) => pick(m, ["type"]) === "worker_done") || null;
      if (drid) orca(["orchestration", "check", "--run", RUN_ID, "--ack", drid]);
      done = drained || { payload: JSON.stringify({ outcome: v.outcome }) };
      break;
    }
    // Freshness: a CHANGING preview proves the TUI is rendering new content
    // (working). A frozen preview for maxIdleMs = hung / parked at a static
    // screen — even if lastOutputAt still ticks (idle repaints). Timestamps
    // are only the fallback when no preview is exposed.
    if (v.preview != null) {
      if (lastPreview === undefined || v.preview !== lastPreview) {
        lastPreview = v.preview;
        lastBusy = Date.now();
      }
    } else if (v.lastBusyMs > 0 && Date.now() - v.lastBusyMs < maxIdleMs) {
      lastBusy = Date.now();
    }
    const silenceMs = Date.now() - lastBusy;
    if (silenceMs >= maxIdleMs) {
      note = `no worker activity for ${Math.round(silenceMs / 60000)}min (dispatch status=${v.status})`;
      break;
    }
    if (Date.now() - startedAt >= hardCapMs) {
      log(`[warn] "${step.title}" still busy after ${Math.round((Date.now() - startedAt) / 60000)}min; ` +
          `leaving its terminal open and stopping the pipeline.`);
      return { outcome: "still-running", note: `still busy after ${Math.round((Date.now() - startedAt) / 60000)}min`, terminal };
    }
  }
  // Settled (done reported) => clean up. Manual path: the terminal is ours,
  // close it. Cold path: the terminal is dispatch-owned, release it. On an
  // unknown outcome keep everything for inspection (per Orca guidance).
  if (done) {
    if (terminal) {
      const c = orca(["terminal", "close", "--terminal", terminal]);
      if (!c.ok) warn(`terminal close '${step.title}' did not confirm: ${c.stderr || c.raw}`);
    } else if (dispatchId) {
      const rel = orca(["orchestration", "worker-release", "--dispatch", dispatchId]);
      if (!rel.ok) warn(`worker-release '${step.title}' did not confirm: ${rel.stderr || rel.raw}`);
    }
  }
  return { outcome: outcomeOf(done) || "unknown", note, terminal };
}

// Gate after a step (if configured)
function runGate(step) {
  const g = orca(["orchestration", "gate-create", "--task", taskIds[step.id],
    "--question", `Approve the result of step "${step.title}"?`, "--options", '["yes","no"]']);
  const gateId = pick(res(g.json).gate || {}, ["id"]) || pick(res(g.json), ["gateId", "gate_id", "id"]);
  log(`  [gate] for "${step.title}". Approve to continue:`);
  log(`     ${ORCA} orchestration gate-resolve --id ${gateId} --resolution yes --json`);
  log(`  (Waiting — resolve the gate in Orca or with the command above.)`);
}

// =============================================================================
// Main loop, with onFailGoto retries
// =============================================================================
const retriesUsed = {};
let i = 0;
while (i < steps.length) {
  const step = steps[i];
  const r = runStep(step);
  const outcome = r.outcome;

  if (outcome === "succeeded") {
    log(`[ok] ${step.title} done -> ${outPath(step.writes)}`);
    if (step.gate) runGate(step);
    i++;
    continue;
  }

  // Healthy but endless worker: the terminal stays open so it can finish.
  // Tell the user exactly how to continue instead of looping or dying blindly.
  if (outcome === "still-running") {
    const next = steps[i + 1];
    die(`"${step.title}" ${r.note}. Its terminal ${r.terminal || "(dispatch-owned)"} was left OPEN to finish. ` +
        `Watch it; once it reports done and writes ${outPath(step.writes)}, continue with:\n` +
        `  node .orca/flow.mjs --from ${next ? next.id : step.id} "<objective>"`);
  }

  // failed / unknown => try onFailGoto
  const gotoId = step.onFailGoto;
  if (gotoId && enabledIds.has(gotoId)) {
    const key = `${step.id}->${gotoId}`;
    retriesUsed[key] = (retriesUsed[key] || 0) + 1;
    if (retriesUsed[key] > MAX_RETRIES) {
      die(`"${step.title}" failed and exhausted ${MAX_RETRIES} retries. See ${outPath(step.writes)}.`);
    }
    log(`[fail] ${step.title} FAILED${r.note ? ` (${r.note})` : ""} -> back to "${byId[gotoId].title}" (attempt ${retriesUsed[key]}/${MAX_RETRIES})`);
    const back = byId[gotoId];
    // Reopen the coding task for another attempt. task-update has no --spec on this
    // build, so we don't rewrite the spec; instead we drop a fix note into the report
    // artifact the coding step already reads. The coding spec + the failing report
    // (REVIEW/SECURITY_REVIEW/TEST_REPORT) tell the agent what to fix.
    orca(["orchestration", "task-update", "--id", taskIds[gotoId], "--status", "ready",
      "--result", JSON.stringify({ reason: `fix from ${step.id} #${retriesUsed[key]}`, see: outPath(step.writes) })]);
    i = steps.findIndex((s) => s.id === gotoId);
    continue;
  }

  die(`"${step.title}" returned outcome=${outcome}${r.note ? ` (${r.note})` : ""} and has no valid onFailGoto. Stopping.`);
}

log("Pipeline COMPLETE. Artifacts in " + ART_DIR + ":");
for (const s of steps) log(`  ${s.title.padEnd(26)} -> ${s.writes}`);
