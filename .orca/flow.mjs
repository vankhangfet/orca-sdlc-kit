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
// Pin the worktree for one run (only when launching from OUTSIDE the target):
//   node .orca/flow.mjs --worktree name:lab2 "..."
//
// Opt-in requirements interview before planning (step id "grill" in config):
//   node .orca/flow.mjs --grill-me "..."
// Disable it for this run when it is enabled in config:
//   node .orca/flow.mjs --no-grill-me "..."
//
// Live status page (auto-opens on real runs; see .orca/CONFIGURATION.md 5.3):
//   node .orca/flow.mjs --no-open-status "..."   // don't auto-open the browser
//   node .orca/flow.mjs --status-preview         // fixture page, no run
//
// Step timeouts: `timeoutMs` = max worker SILENCE (no terminal output, no
// heartbeat). Silence is NOT a failure verdict — a worker deep in one long
// tool call can render a static screen for most of an hour (verified). A
// quiet-but-alive dispatch is waited on and a warning printed; the step only
// settles on worker_done or a POSITIVE failure (dispatch failed). The fix
// loop (onFailGoto) never triggers on "unknown". `hardTimeoutMs` (default
// 4x timeoutMs) = absolute cap — on hit the worker's terminal is left open
// and the flow stops with a --from resume hint (outcome=still-running).
// =============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// Live-page accumulator: null until the status section assigns it (before any
// run starts). `die` uses it to leave a final state on the status page.
let STATUS = null;
const log = (...a) => console.log("[orca-flow]", ...a);
const warn = (...a) => console.warn("[orca-flow]", ...a);
const die = (m) => {
  console.error("[orca-flow] ERROR:", m);
  // Final status write for the live page — only once a run has actually
  // started (runId set by initStatus). Never let this mask the real error.
  if (STATUS?.meta?.runId) {
    // A die from inside a step's support code (task-create, cold-start, gate)
    // never runs statusEnd — downgrade the in-flight step so the page does not
    // show a pulsing RUNNING row under a terminal badge.
    for (const st of STATUS.steps)
      if ((st.status === "running" || st.status === "waiting-approval") && !st.endedAt) st.status = "unknown";
    if (STATUS.overall === "running") STATUS.overall = "failed";
    // Deliberately bypasses the STATUS_FAILED latch: a transient mid-run write
    // failure (e.g. AV file lock) may have healed by exit — last-chance write.
    try { writeStatusTo(statusDir(), STATUS); } catch { }
  }
  process.exit(1);
};

// --- Parse argv: flags + objective ---
const argv = process.argv.slice(2);
const opt = { from: null, only: null, dryRun: false, config: null, agentOverrides: {}, grillMe: undefined, worktree: null, noOpenStatus: false, statusPreview: false };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--from") opt.from = argv[++i];
  else if (a === "--only") opt.only = argv[++i].split(",").map((s) => s.trim());
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--grill-me" || a === "--no-grill-me") {
    const v = a === "--grill-me";
    if (opt.grillMe !== undefined && opt.grillMe !== v) die("--grill-me and --no-grill-me are mutually exclusive.");
    opt.grillMe = v;
  }
  else if (a === "--config") opt.config = argv[++i];
  else if (a === "--worktree") opt.worktree = argv[++i];
  else if (a === "--no-open-status") opt.noOpenStatus = true;
  else if (a === "--status-preview") opt.statusPreview = true;
  else if (a === "--agent") {
    const [step, ag] = argv[++i].split("=");
    if (step && ag) opt.agentOverrides[step] = ag;
  } else rest.push(a);
}
const objective = rest.join(" ").trim();
if (!objective && !opt.dryRun && !opt.statusPreview)
  die('An objective is required, e.g.: node .orca/flow.mjs "Build a login page"');

// --- Load config ---
const CONFIG_FILE = opt.config || "flow.config.json";
let cfg;
try { cfg = JSON.parse(readFileSync(join(HERE, CONFIG_FILE), "utf8")); }
catch (e) { die(`Could not read ${CONFIG_FILE}: ${e.message}`); }

// --grill-me / --no-grill-me: one-shot override of the interview step's enabled
// state (id convention: "grill"). Applied BEFORE normalization so --only/--from
// and read-shrinking all see the final state.
if (opt.grillMe !== undefined) {
  const grill = (cfg.pipeline || []).find((s) => s && s.id === "grill");
  if (!grill) die(`--grill-me/--no-grill-me: ${CONFIG_FILE} has no step with id "grill".`);
  grill.enabled = opt.grillMe;
}

const ART_DIR = cfg.artifactsDir || ".orca/artifacts";
const MAX_RETRIES = cfg.maxRetries ?? 2;
// Fully automatic by default: every spec gets an AUTONOMY directive (never ask
// the user, decide and record assumptions) and per-step "gate" flags are
// ignored — the pipeline runs end-to-end unattended. Set "autoRun": false for
// manual mode: agents may ask questions and steps with "gate": true block on
// an approval gate.
const AUTO_RUN = cfg.autoRun ?? true;
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
    // Soft resolve: during dry-run the worktree may be unresolvable (running
    // from a non-worktree folder) — the plan should still print in full.
    const p = resolveWorktreePath(true);
    return p ? existsSync(join(p, ART_DIR, byId[id].writes)) : false;
  });
}

// Substitute {out} and {reads} in the spec. Mode directives:
// - auto-run: every spec (except the grill interview) gets an AUTONOMY
//   directive so agents do not stall waiting for a human.
// - manual mode: steps flagged "interactive": true get an INTERVIEW protocol
//   (align with the user before finalizing). Ignored in auto-run mode.
function renderSpec(step) {
  const reads = effectiveReads(step);
  const readList = reads.length
    ? reads.map((id) => `${byId[id].title} (${outPath(byId[id].writes)})`).join(", ")
    : "(no prior input — start from the objective)";
  const objectiveLine = `OVERALL OBJECTIVE: ${objective}\n\n`;
  const autonomy = (AUTO_RUN && step.id !== "grill")
    ? "\n\nAUTONOMY: this pipeline runs unattended — do NOT ask the user questions and do NOT wait for confirmation. When something is ambiguous, decide with your best judgment and record it in {out} under an 'Assumptions & decisions' section."
    : "";
  const interview = (!AUTO_RUN && step.interactive)
    ? "\n\nINTERACTIVE SESSION (manual mode): this pipeline runs with user oversight — ALIGN WITH THE USER before finalizing. Interview protocol, follow exactly: (1) Ask ONE question at a time in this terminal and WAIT for the answer; never batch questions. (2) Cover, roughly in order: alignment with the functional requirements and scope; non-functional requirements; performance targets and expected load; security and compliance constraints; scalability and growth expectations; database and persistence choices; technology constraints and team preferences; deployment and operations. (3) Prefer multiple choice; open-ended only when options would bias the answer. (4) After each answer, restate your understanding in one short line so the user can correct you early. (5) Finish with a numbered DECISIONS list (decision + rationale) and get the user's confirmation on each before writing {out}. Include the confirmed decisions and any remaining open points in {out}."
    : "";
  return (objectiveLine + (step.spec || "") + autonomy + interview)
    .replaceAll("{out}", outPath(step.writes))
    .replaceAll("{tasks}", step.progress ? outPath(step.progress) : "{tasks}")
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
// Where agents run. Precedence:
//   1. --worktree <selector>         (one-off run)
//   2. ORCA_FLOW_WORKTREE env        (per machine / shell)
//   3. defaults.worktree in config   (explicit pin)
//   4. auto-detect: the Orca worktree containing the invoking directory
// Auto-detect is the DEFAULT on purpose: a hardcoded pin ships badly (users
// forget to change it, then the flow targets a foreign worktree or dies with
// selector_not_found mid-run). Pin only when launching from OUTSIDE the
// target worktree. A pinned selector is validated BEFORE anything is created,
// and on failure we list the available worktrees.
const WT_PIN = opt.worktree || process.env.ORCA_FLOW_WORKTREE || cfg.defaults?.worktree || null;
const wtSource = () => opt.worktree ? "--worktree flag"
  : process.env.ORCA_FLOW_WORKTREE ? "ORCA_FLOW_WORKTREE env"
  : cfg.defaults?.worktree ? "config defaults.worktree" : "auto-detect";
let WT = null;
let WT_WARNED = false;   // soft mode: report an unresolvable worktree only once
// Filesystem path of the worktree (agents run THERE, so artifacts live there —
// not necessarily next to this config). Null until resolvable.
let WT_PATH = null;
// Human-readable worktree list for error messages. `worktree list` is GLOBAL
// across repos, so prefer worktrees under the git root of the CWD; fall back
// to all when none match.
function worktreeCandidates() {
  const l = orca(["worktree", "list"]);
  const ws = (pick(res(l.json), ["worktrees"]) || [])
    .map((w) => ({ name: pick(w, ["displayName"]) || "", path: pick(w, ["path"]) || "" }))
    .filter((w) => w.name && w.path);
  let root = null;
  const g = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (!g.error && g.status === 0) root = (g.stdout || "").trim().toLowerCase();
  const same = root ? ws.filter((w) => {
    const p = w.path.toLowerCase();
    return p === root || p.startsWith(root + "\\") || p.startsWith(root + "/");
  }) : [];
  return (same.length ? same : ws).slice(0, 8)
    .map((w) => `  name:${w.name}  ->  ${w.path}`).join("\n");
}
const wtFixHint = () =>
  "Fix one of:\n" +
  "  - run the flow from inside the target Orca worktree (auto-detect), or\n" +
  "  - pass --worktree <selector> for this run, or\n" +
  "  - set ORCA_FLOW_WORKTREE for this machine/shell, or\n" +
  '  - set "defaults": { "worktree": "name:<displayName>" } in the config.';
function resolveWorktree(soft = false) {
  if (WT) return WT;
  if (WT_PIN) {
    const shown = orca(["worktree", "show", "--worktree", WT_PIN]);
    const p = pick(res(shown.json).worktree || {}, ["path"]);
    if (shown.ok && p) { WT = WT_PIN; WT_PATH = p; return WT; }
    const cands = worktreeCandidates();
    const msg = `worktree "${WT_PIN}" (from ${wtSource()}) does not exist.\n${wtFixHint()}` +
      (cands ? `\nAvailable worktrees:\n${cands}` : "");
    if (soft) { if (!WT_WARNED) { WT_WARNED = true; warn(msg); } return null; }
    die(msg);
  }
  const w = orca(["worktree", "current"]);
  const entry = pick(res(w.json), ["worktree"]) || res(w.json);
  const p = pick(entry, ["path"]);
  if (w.ok && p) { WT = `path:${p}`; WT_PATH = p; return WT; }
  if (soft) return null;
  const cands = worktreeCandidates();
  die("Could not auto-detect the worktree: the invoking directory is not inside an " +
      `Orca-managed worktree.\n${wtFixHint()}` +
      (cands ? `\nAvailable worktrees:\n${cands}` : ""));
}
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

// =============================================================================
// Live status page (zero-dep). While agents run, the flow keeps a snapshot in
// <worktree>/<artifactsDir>/:
//   status.html — written ONCE per run (STATUS_HTML below; static page).
//   status.js   — rewritten at every step event; contains window.__STATUS={...}.
// The page re-creates a <script src="status.js"> tag every 2s: classic script
// tags are NOT CORS-blocked on file:// (fetch is), so a double-clicked page
// live-updates with no server. Status writes must NEVER kill a run: the first
// failure warns once, then the page is abandoned.
// =============================================================================
STATUS = {
  meta: {
    runId: null, objective, config: CONFIG_FILE, worktree: null,
    startedAt: null, updatedAt: null,
  },
  overall: "running",   // running | succeeded | failed | unknown | still-running
  steps: allSteps.map((s) => ({
    id: s.id, title: s.title, agent: agentOf(s), writes: s.writes || null,
    progress: s.progress || null,
    status: enabledIds.has(s.id) ? "pending" : "skipped",
    attempt: 0, startedAt: null, endedAt: null, durationMs: null, note: null,
    tasks: null,
  })),
  artifacts: [],
};
let STATUS_FAILED = false;
// Terminal for merge purposes. "unknown" is included beyond the spec's three:
// a settled-unknown row is more informative than a bare SKIPPED strikethrough.
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "skipped", "unknown"]);
function statusDir() { return join(WT_PATH || ".", ART_DIR); }
const statusJsOf = (S) =>
  `window.__STATUS=${JSON.stringify(S)};window.__ON_STATUS&&window.__ON_STATUS();`;
function writeStatusTo(dir, S) { writeFileSync(join(dir, "status.js"), statusJsOf(S)); }
function writeStatus() {
  if (STATUS_FAILED) return;
  try {
    STATUS.meta.updatedAt = Date.now();
    writeStatusTo(statusDir(), STATUS);
  } catch (e) {
    STATUS_FAILED = true;
    warn(`status page write failed (${e.message}); continuing without it.`);
  }
}
const statusOf = (id) => STATUS.steps.find((x) => x.id === id) || null;
function statusSet(id, patch) { const st = statusOf(id); if (st) Object.assign(st, patch); }
function statusBegin(id) {
  const st = statusOf(id);
  if (!st) return;
  st.status = "running"; st.attempt += 1;
  st.startedAt = Date.now(); st.endedAt = null; st.durationMs = null; st.note = null;
  writeStatus();
}
function statusEnd(id, outcome, note) {
  const st = statusOf(id);
  if (!st) return;
  st.status = outcome === "succeeded" ? "succeeded"
    : outcome === "failed" ? "failed"
    // still-running: its terminal was left open to finish — keep it visually live
    : outcome === "still-running" ? "running" : "unknown";
  st.endedAt = Date.now();
  if (st.startedAt) st.durationMs = st.endedAt - st.startedAt;
  st.note = note || null;
  writeStatus();
}
function finishStatus(overall) {
  STATUS.overall = overall;
  STATUS.artifacts = steps.map((s) => outPath(s.writes));
  writeStatus();
}

// Parse a progress checklist (e.g. TASKS.md) an agent maintains mid-step.
// Grammar: one checkbox per line — "- [ ]" todo, "- [~]" doing, "- [x]"/"- [X]"
// done; an indent of 2+ spaces marks a sub-task. Every other line (headers,
// prose, blanks) is ignored. Returns the task array, or null when the text has
// no checkbox at all. DISPLAY ONLY: callers swallow all errors — a missing or
// mangled file never affects the run.
function parseProgress(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^(\s*)-\s*\[([ xX~])\]\s*(.*)$/);
    if (!m) continue;
    out.push({
      status: m[2] === " " ? "todo" : m[2] === "~" ? "doing" : "done",
      level: m[1].length >= 2 ? 1 : 0,
      text: m[3].trim(),
    });
  }
  return out.length ? out : null;
}

// Display-only refresh of a step's task checklist from its `progress` file.
// Swallows everything: the file appears only once the agent writes it and may
// be mid-write at any read — a good parse replaces the snapshot, errors keep it.
function refreshProgress(step) {
  if (!step.progress) return;
  try {
    const tasks = parseProgress(readFileSync(join(statusDir(), step.progress), "utf8"));
    if (tasks) statusSet(step.id, { tasks });
  } catch { /* not written yet / unreadable — keep the last snapshot */ }
}

// Resume merge: when a previous status.js from the SAME config exists in the
// artifacts dir, carry its history into this run — a `--from` resume then
// shows one continuous picture. Steps excluded from THIS run ("skipped",
// e.g. everything before --from) adopt their previous terminal state and
// timings; steps that WILL run keep "pending" but continue their attempt
// counter, so a resumed fix loop renders as attempt 2, 3, ...
function loadPreviousStatus(dir = statusDir()) {
  try {
    const p = join(dir, "status.js");
    if (!existsSync(p)) return;
    const m = readFileSync(p, "utf8").match(/window\.__STATUS=([\s\S]*?);window\.__ON_STATUS/);
    if (!m) return;
    const prev = JSON.parse(m[1]);
    if (!prev || !Array.isArray(prev.steps) || prev.meta?.config !== STATUS.meta.config) return;
    for (const ps of prev.steps) {
      const cur = statusOf(ps.id);
      if (!cur) continue;
      if (cur.status === "skipped" && TERMINAL_STATUSES.has(ps.status)) {
        Object.assign(cur, { status: ps.status,
          attempt: Math.max(cur.attempt, ps.attempt || 0),
          startedAt: ps.startedAt ?? null, endedAt: ps.endedAt ?? null,
          durationMs: ps.durationMs ?? null, note: ps.note ?? null });
      } else if (cur.status === "pending" && prev.overall !== "succeeded") {
        // Attempts carry only across an INCOMPLETE previous run (resume of a
        // fix loop) — a clean re-run of a fully-succeeded pipeline starts
        // every step at attempt 1, not a phantom "attempt 2".
        cur.attempt = Math.max(cur.attempt, ps.attempt || 0);
      }
    }
  } catch { /* unreadable previous status — start fresh */ }
}

// Called once, right after run-create: fills meta, merges any previous run's
// status, writes both files, opens the page.
function initStatus() {
  STATUS.meta.runId = RUN_ID;
  STATUS.meta.worktree = WT || WT_PIN || "(auto-detect)";
  STATUS.meta.startedAt = Date.now();
  loadPreviousStatus();
  // Steps whose progress file already exists (an earlier run in this
  // worktree) start with its checklist — a `--from` resume then shows the
  // final task list even for steps that will not run again.
  for (const st of STATUS.steps) refreshProgress(st);
  try {
    writeFileSync(join(statusDir(), "status.html"), STATUS_HTML);
  } catch (e) {
    STATUS_FAILED = true;
    warn(`status page could not be written (${e.message}); continuing without it.`);
    return;
  }
  writeStatus();
  openStatusPage();
  log(`Status page: ${join(statusDir(), "status.html")}`);
}
// explorer.exe always exits non-zero (even on success) — its exit code is noise.
function openStatusPage() {
  if (STATUS_FAILED) return;   // page was abandoned — don't open a dead tab
  if (opt.noOpenStatus || !(cfg.defaults?.openStatus ?? true)) return;
  const file = join(statusDir(), "status.html");
  const r = IS_WIN ? spawnSync("explorer.exe", [file], { timeout: 10000, stdio: "ignore" })
    : process.platform === "darwin" ? spawnSync("open", [file], { timeout: 10000, stdio: "ignore" })
    : spawnSync("xdg-open", [file], { timeout: 10000, stdio: "ignore" });
  if (r.error) warn(`could not auto-open the status page (${r.error.message}) — open it yourself: ${file}`);
}

// Dev fixture covering EVERY state, rendered without an Orca run. With the
// shipped flow.config.json the index mapping is: grill skipped (real config),
// planning/architecture succeeded, detailed-design RUNNING, uiux-design NEXT,
// coding failed attempt 2, code-review awaiting approval, security-review
// unknown, testing skipped, documentation pending.
function previewStatus() {
  const S = JSON.parse(JSON.stringify(STATUS));
  S.meta.runId = "preview-run-0000";
  S.meta.worktree = WT || WT_PIN || "(preview)";
  S.meta.startedAt = Date.now() - 3720000;
  S.meta.updatedAt = Date.now();
  S.overall = "running";
  const t = Date.now();
  S.steps.forEach((s, idx) => {
    if (s.status === "skipped") return;          // keep real config skips visible
    if (idx < 3) {
      s.status = "succeeded"; s.attempt = 1;
      s.startedAt = t - 3720000 + idx * 600000; s.endedAt = s.startedAt + 240000 + idx * 30000;
      s.durationMs = s.endedAt - s.startedAt;
    } else if (idx === 3) { s.status = "running"; s.attempt = 1; s.startedAt = t - 757000; }
    else if (idx === 4) { /* stays pending — renders the NEXT chip */ }
    else if (idx === 5) { s.status = "failed"; s.attempt = 2; s.startedAt = t - 600000; s.endedAt = t - 300000; s.durationMs = 300000; s.note = "tests failed (preview fixture)"; }
    else if (idx === 6) { s.status = "waiting-approval"; s.attempt = 1; s.startedAt = t - 120000; s.note = "gate open (preview fixture)"; }
    else if (idx === 7) { s.status = "unknown"; s.attempt = 1; s.note = "no worker_done seen (preview fixture)"; }
    else if (idx === 8) { s.status = "skipped"; }
  });
  return S;
}

// The page itself. Client behaviors: re-creates <script src="status.js"> every
// 2s (classic scripts load fine from file://), re-renders every 1s so running
// timers and "updated Xs ago" tick between snapshots, escapes all strings.
const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Orca Flow — pipeline status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background:#0d1017; color:#d7dce4; font:14px/1.5 "Segoe UI",system-ui,-apple-system,sans-serif; padding:24px; }
  .wrap { max-width: 860px; margin: 0 auto; }
  .card { background:#151a23; border:1px solid #232b38; border-radius:10px; padding:18px 20px; margin-bottom:14px; }
  .objective { font-size:16px; font-weight:600; margin-bottom:6px; word-wrap:break-word; }
  .meta { color:#8b949e; font-size:12px; display:flex; flex-wrap:wrap; gap:14px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.5px; margin-bottom:8px; }
  .badge.running { background:#0c2d1b; color:#3fb950; border:1px solid #1d4428; animation:pulse 1s infinite; }
  .badge.succeeded { background:#0c2d1b; color:#3fb950; border:1px solid #1d4428; }
  .badge.failed, .badge.unknown { background:#2d0c0e; color:#f85149; border:1px solid #442126; }
  .badge.still-running { background:#2d230c; color:#d29922; border:1px solid #44361d; }
  @keyframes pulse { 50% { opacity:.55; } }
  .bar { height:8px; background:#21262d; border-radius:4px; overflow:hidden; margin:10px 0 2px; }
  .bar > i { display:block; height:100%; background:#3fb950; transition:width .4s; }
  .count { color:#8b949e; font-size:12px; }
  .step { display:flex; align-items:center; gap:12px; padding:10px 6px; border-bottom:1px solid #1c2330; flex-wrap:wrap; }
  .step:last-child { border-bottom:none; }
  .glyph { width:22px; text-align:center; font-weight:700; flex:none; }
  .name { font-weight:600; }
  .step.pending .name, .step.skipped .name { color:#6e7681; font-weight:400; }
  .step.skipped .name { text-decoration: line-through; }
  .agent { color:#58a6ff; font-size:12px; flex:none; min-width:86px; }
  .dur { color:#8b949e; font-size:12px; margin-left:auto; flex:none; font-variant-numeric:tabular-nums; }
  .note { color:#d29922; font-size:12px; flex-basis:100%; }
  .step.running .glyph, .step.running .name { color:#3fb950; }
  .step.running .glyph { animation:pulse 1s infinite; }
  .step.succeeded .glyph { color:#3fb950; }
  .step.failed .glyph, .step.failed .name { color:#f85149; }
  .step.unknown .glyph { color:#8b949e; }
  .step.waiting-approval .glyph, .step.waiting-approval .name { color:#d29922; }
  .next { border-left:2px solid #58a6ff; padding-left:10px; }
  .chip { font-size:10px; font-weight:700; letter-spacing:.5px; color:#58a6ff; border:1px solid #1f3a5f; border-radius:4px; padding:1px 6px; margin-left:8px; vertical-align:1px; }
  .chip.retry { color:#d29922; border-color:#44361d; }
  .arts { font-size:12px; color:#8b949e; word-break:break-all; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card" id="head"></div>
  <div class="card" id="list"></div>
  <div class="card arts" id="arts" style="display:none"></div>
</div>
<script>
(function () {
  var S = null;
  var GLYPH = { pending:"○", running:"▶", succeeded:"✓", failed:"✗",
                skipped:"⊘", unknown:"?", "waiting-approval":"⏸" };
  var LABEL = { pending:"PENDING", running:"RUNNING", succeeded:"DONE", failed:"FAILED",
                skipped:"SKIPPED", unknown:"UNKNOWN", "waiting-approval":"AWAITING APPROVAL",
                "still-running":"STILL RUNNING" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]; }); }
  function dur(ms) {
    if (ms == null) return "";
    var s = Math.max(0, Math.round(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    s %= 60;
    return h ? h + "h " + String(m).padStart(2, "0") + "m" : m + "m " + String(s).padStart(2, "0") + "s";
  }
  function since(ts) { return ts ? Math.max(0, Date.now() - ts) : null; }
  function render() {
    if (!S) return;
    var runIdx = -1;
    for (var k = 0; k < S.steps.length; k++) {
      var rs = S.steps[k].status;
      if (rs === "running" || rs === "waiting-approval") { runIdx = k; break; }
    }
    var nextIdx = -1;
    if (runIdx >= 0) for (var j = runIdx + 1; j < S.steps.length; j++)
      if (S.steps[j].status === "pending") { nextIdx = j; break; }
    var done = 0;
    S.steps.forEach(function (s) { if (s.status === "succeeded" || s.status === "skipped") done++; });
    var pct = S.steps.length ? Math.round((done / S.steps.length) * 100) : 0;
    document.getElementById("head").innerHTML =
      '<div class="badge ' + esc(S.overall) + '">' + esc(LABEL[S.overall] || String(S.overall || "").toUpperCase()) + "</div>" +
      '<div class="objective">' + esc(S.meta.objective || "(no objective)") + "</div>" +
      '<div class="meta"><span>run: ' + esc(String(S.meta.runId || "").slice(0, 8)) + "</span>" +
      "<span>worktree: " + esc(S.meta.worktree || "-") + "</span>" +
      "<span>config: " + esc(S.meta.config || "-") + "</span>" +
      "<span>elapsed: " + dur(since(S.meta.startedAt)) + "</span>" +
      "<span>updated " + Math.max(0, Math.round((Date.now() - S.meta.updatedAt) / 1000)) + "s ago</span></div>" +
      '<div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="count">' + done + "/" + S.steps.length + " steps done</div>";
    var html = "";
    S.steps.forEach(function (s, i) {
      var liveDur = (s.status === "running" || s.status === "waiting-approval") ? dur(since(s.startedAt)) : dur(s.durationMs);
      html += '<div class="step ' + esc(s.status) + (i === nextIdx ? " next" : "") + '">' +
        '<span class="glyph">' + (GLYPH[s.status] || "·") + "</span>" +
        '<span class="name">' + esc(s.title) +
        (i === nextIdx ? '<span class="chip">NEXT</span>' : "") +
        (s.attempt > 1 ? '<span class="chip retry">attempt ' + s.attempt + "</span>" : "") +
        "</span>" +
        '<span class="agent">' + esc(s.agent || "") + "</span>" +
        '<span class="dur">' + liveDur + "</span>" +
        (s.note ? '<span class="note">' + esc(s.note) + "</span>" : "") +
        "</div>";
    });
    document.getElementById("list").innerHTML = html;
    var arts = document.getElementById("arts");
    if (S.artifacts && S.artifacts.length) {
      arts.style.display = "";
      arts.innerHTML = "<b>Artifacts</b><br>" + S.artifacts.map(esc).join(" · ");
    }
  }
  window.__ON_STATUS = function () { S = window.__STATUS; render(); };
  setInterval(render, 1000);   // running timers + "updated Xs ago" stay fresh
  function load() {            // classic <script src> loads fine on file://
    var old = document.getElementById("sloader");
    if (old) old.remove();
    var sc = document.createElement("script");
    sc.id = "sloader";
    sc.src = "status.js?ts=" + Date.now();
    document.head.appendChild(sc);
  }
  load();
  setInterval(load, 2000);
})();
</script>
</body>
</html>
`;

// Terminal command for an agent. Claude Code on Windows can crash with
// EBADF when its file watcher races the create/delete of
// ~/.claude/history.jsonl.lock, which is written on every user prompt
// (anthropics/claude-code#15739) — hit hardest by the interactive grill
// step. Skipping prompt history for flow-spawned claude agents removes the
// lock churn. NOTE: the CLI gates on the exact string "true" (not "1").
// Only the manual path can inject env; the cold-start fallback (--agent)
// launches the TUI Orca-side and stays unprotected.
function agentCommand(agent) {
  if (agent !== "claude") return agent;
  return IS_WIN
    ? `cmd /c "set CLAUDE_CODE_SKIP_PROMPT_HISTORY=true&& claude"`
    : `env CLAUDE_CODE_SKIP_PROMPT_HISTORY=true claude`;
}

function warmTerminal(agent) {
  const startedAt = Date.now();
  const c = orca(["terminal", "create", "--worktree", resolveWorktree(), "--command", agentCommand(agent)]);
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
    writeStatus();   // startup heartbeat: page stays fresh during TUI warmup
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

  // A large paste can collapse into an input-box chip that swallows the
  // trailing Enter — the prompt then sits UNsubmitted forever (verified:
  // a codex terminal frozen on "[Pasted Content 5237 chars]", no heartbeat,
  // dispatch never settled). A bare Enter a few seconds later submits it,
  // and is a no-op when the paste already went through (verified on codex;
  // other TUIs ignore Enter on an empty input).
  sleepMs(3000);
  orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"]);

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
      writeStatus();   // startup heartbeat: page stays fresh while watching the paste
      const pv = previewOf(term);
      if (pv == null || before == null || pv !== before) return { dispatchId, terminal: term };
    }
    if (attempt < SEND_ATTEMPTS) {
      // Attempt 2 nudges with a bare Enter (submits a pending paste chip
      // without duplicating it); attempt 3 re-sends the full preamble.
      const nudge = attempt === 1;
      warn(`no sign the '${step.title}' prompt was consumed; ${nudge ? "nudging with Enter" : "re-sending"} (${attempt + 1}/${SEND_ATTEMPTS})`);
      const s2 = nudge
        ? orca(["terminal", "send", "--terminal", term, "--text", "", "--enter"])
        : orca(["terminal", "send", "--terminal", term, "--text",
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
  log(`Worktree: ${WT || WT_PIN || "(auto-detect, unresolved in dry-run)"}  (${wtSource()})`);
  log(`Auto-run: ${AUTO_RUN ? "on — agents run unattended, gates ignored" : "off — steps with 'gate' block for approval"}`);
  log("Pipeline to run (in order):");
  steps.forEach((s, i) => {
    const reads = effectiveReads(s);
    const flags = [];
    if (s.onFailGoto && enabledIds.has(s.onFailGoto)) flags.push(`onFail->${s.onFailGoto}`);
    if (s.gate && !AUTO_RUN) flags.push("gate");
    if (s.interactive && !AUTO_RUN) flags.push("interactive");
    console.log(
      `  ${i + 1}. ${s.title.padEnd(26)} agent=${agentOf(s).padEnd(9)} ` +
      `reads=[${reads.join(", ") || "-"}] writes=${s.writes}` +
      (flags.length ? `  {${flags.join(", ")}}` : "")
    );
  });
  const skipped = allSteps.filter((s) => !enabledIds.has(s.id)).map((s) => s.id);
  if (skipped.length) log(`Skipped: ${skipped.join(", ")}`);
}

// --status-preview renders a SAMPLE dashboard and exits without calling
// agents. Combined with a real run's trappings (objective / --only / --from /
// --agent) it almost certainly means the user wanted a REAL run with the
// status page — which is already the default and needs no flag. Refuse the
// ambiguous mix instead of silently skipping the pipeline (verified incident:
// "--only planning,architecture "<objective>" --status-preview" exited after
// writing the fixture and no agent ever spawned).
if (opt.statusPreview && (objective || opt.only || opt.from || Object.keys(opt.agentOverrides).length))
  die("--status-preview renders a SAMPLE status page and exits WITHOUT calling agents, but this command looks like a real run (objective/--only/--from/--agent present). Remove --status-preview to run the pipeline for real — the status page opens automatically — or drop the objective and selectors to see the sample page.");

// Dev fixture: render the status page with every state represented, without
// an Orca run. ORCA_STATUS_PREVIEW_RESUME=1 additionally exercises the resume
// merge: a previous run's status.js is simulated, then merged exactly like a
// --from resume would.
if (opt.statusPreview) {
  const dir = join(HERE, "status-preview");
  try {
    mkdirSync(dir, { recursive: true });
    if (process.env.ORCA_STATUS_PREVIEW_RESUME) {
      writeStatusTo(dir, previewStatus());
      // Pretend this run started --from the 5th step: earlier ones are
      // excluded ("skipped"), exactly like --from — the merge must then adopt
      // their previous terminal state for the page.
      STATUS.steps.forEach((s, idx) => { if (idx < 4) s.status = "skipped"; });
      STATUS.meta.worktree = WT || WT_PIN || "(preview)";
      STATUS.meta.startedAt = Date.now() - 3720000;
      STATUS.meta.updatedAt = Date.now();
      loadPreviousStatus(dir);
    }
    writeFileSync(join(dir, "status.html"), STATUS_HTML);
    writeStatusTo(dir, process.env.ORCA_STATUS_PREVIEW_RESUME ? STATUS : previewStatus());
    log(`Status preview: ${join(dir, "status.html")}` +
        (process.env.ORCA_STATUS_PREVIEW_RESUME ? " (resume merge exercised)" : ""));
  } catch (e) { warn(`status preview failed: ${e.message}`); }
  process.exit(0);
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
initStatus();

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

  // Manual-mode interactive steps sit idle while waiting for human answers —
  // give them the same generous budgets as the grill interview.
  const interactiveNow = !AUTO_RUN && step.interactive;
  const baseIdleMs = timeoutOf(step);
  const baseHardMs = step.hardTimeoutMs ?? cfg.defaults?.hardTimeoutMs ?? 4 * baseIdleMs;
  const maxIdleMs = interactiveNow ? Math.max(baseIdleMs, 3600000) : baseIdleMs;
  const hardCapMs = interactiveNow ? Math.max(baseHardMs, 14400000) : baseHardMs;
  const SLICE_MS = Math.min(120000, maxIdleMs);
  const startedAt = Date.now();
  let lastBusy = Date.now();
  let lastPreview;                 // undefined = not observed yet (baseline)
  let done = null, note = "";
  let quietWarned = false;         // warn once about a quiet-but-alive worker
  while (true) {
    refreshProgress(step);   // task checklist snapshot (display-only)
    writeStatus();   // heartbeat: keep the page's "updated Xs ago" fresh each slice
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
    // Hard cap first: absolute per-step limit, busy or quiet.
    if (Date.now() - startedAt >= hardCapMs) {
      log(`[warn] "${step.title}" not settled after ${Math.round((Date.now() - startedAt) / 60000)}min; ` +
          `leaving its terminal open and stopping the pipeline.`);
      return { outcome: "still-running", note: `not settled after ${Math.round((Date.now() - startedAt) / 60000)}min`, terminal };
    }
    // Silence alone is NOT proof of death: a worker deep in one long tool
    // call renders a static screen for tens of minutes (verified incident:
    // a 60-min code review was falsely failed at 15 min while its dispatch
    // was alive, and the blind retry double-dispatched the task while the
    // reviewer was still working). Only a POSITIVE failure (dispatch failed
    // / worker_report) settles a step as failed; a quiet-but-alive dispatch
    // is waited on up to the hard cap above, then left running.
    if (silenceMs >= maxIdleMs && !quietWarned) {
      quietWarned = true;
      warn(`"${step.title}" quiet for ${Math.round(silenceMs / 60000)}min but its dispatch is alive (status=${v.status}) — ` +
           `waiting up to the ${Math.round(hardCapMs / 60000)}min hard cap before giving up.`);
      statusSet(step.id, { note: `quiet ${Math.round(silenceMs / 60000)}min but alive — waiting to the hard cap` });
      writeStatus();
    }
  }
  refreshProgress(step);   // final snapshot: catch the last ticks before worker_done
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

// Gate after a step (manual mode only — autoRun ignores gates entirely).
// Blocks until the gate is resolved (or defaults.gateTimeoutMs passes).
function runGate(step) {
  const g = orca(["orchestration", "gate-create", "--task", taskIds[step.id],
    "--question", `Approve the result of step "${step.title}"?`, "--options", '["yes","no"]']);
  const gateId = pick(res(g.json).gate || {}, ["id"]) || pick(res(g.json), ["gateId", "gate_id", "id"]);
  log(`  [gate] for "${step.title}". Approve to continue:`);
  log(`     ${ORCA} orchestration gate-resolve --id ${gateId} --resolution yes --json`);
  log(`  (Waiting — resolve the gate in Orca or with the command above.)`);
  statusSet(step.id, { status: "waiting-approval", note: "gate open — approve to continue" });
  writeStatus();
  const GATE_TIMEOUT_MS = cfg.defaults?.gateTimeoutMs ?? 3600000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < GATE_TIMEOUT_MS) {
    sleepMs(5000);
    writeStatus();   // heartbeat: a human may sit on this gate for up to gateTimeoutMs
    const l = orca(["orchestration", "gate-list", "--run", RUN_ID]);
    const gates = pick(res(l.json), ["gates"]) || [];
    const gate = gates.find((x) =>
      pick(x, ["id"]) === gateId || pick(x, ["gateId", "gate_id"]) === gateId);
    if (!gate) continue;                       // not listed (yet)
    const status = String(pick(gate, ["status", "state"]) ?? "");
    const resolution = pick(gate, ["resolution", "answer", "result"]);
    if (resolution == null && /^(pending|open|waiting|created)$/i.test(status)) continue;
    const verdict = String(resolution ?? status).toLowerCase();
    if (verdict === "yes" || verdict === "approved" || verdict === "resolved") {
      statusSet(step.id, { status: "succeeded", note: null });
      writeStatus();
      return;
    }
    statusSet(step.id, { note: "gate rejected" });
    die(`Gate for "${step.title}" was resolved with "${resolution ?? status}" — stopping the pipeline.`);
  }
  warn(`gate for "${step.title}" not resolved within ${Math.round(GATE_TIMEOUT_MS / 60000)}min; continuing anyway.`);
  statusSet(step.id, { status: "succeeded", note: "gate timeout — continued anyway" });
  writeStatus();
}

// =============================================================================
// Main loop, with onFailGoto retries
// =============================================================================
const retriesUsed = {};
let i = 0;
while (i < steps.length) {
  const step = steps[i];
  statusBegin(step.id);
  const r = runStep(step);
  const outcome = r.outcome;
  statusEnd(step.id, outcome, r.note);

  if (outcome === "succeeded") {
    log(`[ok] ${step.title} done -> ${outPath(step.writes)}`);
    if (step.gate && !AUTO_RUN) runGate(step);
    i++;
    continue;
  }

  // Healthy but endless worker: the terminal stays open so it can finish.
  // Tell the user exactly how to continue instead of looping or dying blindly.
  if (outcome === "still-running") {
    STATUS.overall = "still-running";   // die() only overwrites "running"
    writeStatus();
    const next = steps[i + 1];
    die(`"${step.title}" ${r.note}. Its terminal ${r.terminal || "(dispatch-owned)"} was left OPEN to finish. ` +
        `Watch it; once it reports done and writes ${outPath(step.writes)}, continue with:\n` +
        `  node .orca/flow.mjs --from ${next ? next.id : step.id} "<objective>"`);
  }

  // Only a POSITIVE failed outcome may trigger the onFailGoto fix loop.
  // Anything else ("unknown": silent worker, lost report) means we could not
  // tell — a blind retry has double-dispatched a live task before (the
  // reviewer was still working when the coder was re-started under it).
  if (outcome !== "failed")
    die(`"${step.title}" returned outcome=${outcome}${r.note ? ` (${r.note})` : ""}. ` +
        `Not retrying without a definite failure — inspect the terminal/artifacts, then re-run with --from ${step.id}.`);

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

finishStatus("succeeded");
log("Pipeline COMPLETE. Artifacts in " + ART_DIR + ":");
for (const s of steps) log(`  ${s.title.padEnd(26)} -> ${s.writes}`);
