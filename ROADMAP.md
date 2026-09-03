# Orca SDLC Flow Kit — Roadmap

Last updated: 2026-09-03 (after v1.1.0 — task-level progress)
Status: proposal, nothing committed to a milestone yet.

## Guiding principles (every item must respect these)

1. **Behavior lives in configs** (Rule #1): new knobs are JSON fields; `flow.mjs` stays a generic executor.
2. **Zero dependencies, Node only** — no server, no ports, no npm install. The status page keeps working from `file://`.
3. **Display never kills a run** — anything observation-flavored (status page, logs, tracking) must be unable to change outcomes, timeouts, retries, liveness.
4. **Cross-platform from day one** (Windows quirks are first-class, not ports).

Sizes: S ≤ ~50 LOC / 1 file · M ~50–150 LOC or 2–3 files · L > 150 LOC or new concepts.

---

## HORIZON 1 — Quick wins (high value, small)

### 1. Run history on the status page — M
**Pain:** every run overwrites `status.js`; once the flow exits the page is frozen, and there is no way to compare runs ("which step failed last time, how long did coding take across runs?").
**Plan:** keep `status-<runId8>.js` snapshots beside the current `status.js`; the page gets a run selector (fetch by re-creating `<script src>` per selection); current run stays the default. Cap retention (e.g. last 20) to bound disk.
**Lands in:** `flow.mjs` (status write path) + `STATUS_HTML`.

### 2. Artifact viewer in the status page — M
**Pain:** PLAN.md, ARCHITECTURE.md, REVIEW.md, TASKS.md all sit next to `status.js`, but reviewing them means hunting files in the worktree.
**Plan:** each step row gets an artifact link; the page lazy-loads `<artifact>.md` files via classic `<script src>` wrappers (same file:// trick as status.js — wrap content as `window.__ARTIFACT["PLAN.md"]=...`, written by the flow on each status write; fall back to "open in editor" hint if a file is absent). Render as preformatted text with basic heading/code styling — NOT a full Markdown engine (zero-dep principle).
**Lands in:** `flow.mjs` (write `artifacts.js`) + `STATUS_HTML`.

### 3. Auto-resume (`--from auto`) — S/M
**Pain:** after a crash/hard-cap, the user must read the resume hint and type `--from <step>` with the right id.
**Plan:** `--from auto` loads the previous `status.js` + checks artifact existence on disk, picks the last step that did not settle as succeeded (or the step after the last succeeded one), prints what it chose and why, and continues. Manual `--from <id>` keeps precedence.
**Lands in:** `flow.mjs` (resume resolution before pipeline normalization).

### 4. Deep config validation at dry-run — S
**Pain:** `reads` pointing at a non-existent id, `onFailGoto` pointing forward, unknown agent names, `progress` file equal to another step's `writes`, duplicate ids — all surface mid-run or never.
**Plan:** a `validateConfig()` pass run before `printPlan()` in every mode (not just dry-run): reference graph checks, cycle check for onFailGoto, agent-name check against the known catalog + kiro-cli, duplicate/missing fields, writes/progress filename collisions. Fail fast with precise messages.
**Lands in:** `flow.mjs`; documented in CONFIGURATION.md §7 (safe-editing workflow).

### 5. `model` / `effort` honored on the manual path — S (bug-fix grade)
**Pain:** the fields only work on the cold-start fallback (`coldStart()` passes `--model/--effort`); the PRIMARY manual dispatch path (`manualStart()`) silently ignores them — users configure values that never take effect.
**Plan:** map per-agent: claude/codex/cursor accept model/effort via env or CLI flag on `terminal create --command` (agentCommand() already wraps commands; extend the wrapper). Document per-agent support honestly in CONFIGURATION.md.
**Lands in:** `flow.mjs` `agentCommand()` + docs.

---

## HORIZON 2 — Pipeline productivity

### 6. Parallel independent steps — M/L
**Pain:** the pipeline is strictly sequential; `detailed-design` and `uiux-design` (and others in user configs) do not depend on each other but run one after another — 20–30% wasted wall-clock per run.
**Plan:** config field `"parallelWith": "<id>"` (explicit beats auto-detection for predictability — auto can come later as `--dry-run` hint). The main loop runs each branch's worker and merges on a join barrier before any step that `reads` both. Status page already handles multiple "running" rows. Fix-loop interactions must be defined (a failed parallel branch pauses the join; onFailGoto from later steps unchanged).
**Lands in:** `flow.mjs` (main loop) + CONFIGURATION.md; fixture/preview updates.

### 7. Run log artifact — S
**Pain:** everything the flow prints (`[orca-flow]` lines, warnings, gate hints) lives only in the console; post-mortems scroll terminals.
**Plan:** a `tee`-style log() wrapper writing `FLOW_LOG.md` into the artifacts dir (append per run, newest first section with runId + objective + timestamps). Cheap, and makes #1 (history) far more useful.
**Lands in:** `flow.mjs` logging functions.

### 8. End-of-run notifications — S/M
**Pain:** runs take hours; nobody watches. Users find out a run failed the next morning.
**Plan:** config `"notify": {"onEnd": "<command>", "onFail": "<command>"}` executed via spawnSync WITHOUT shell (argv-safe, consistent with the repo's Windows rules); a few env vars passed to the command (status, objective, failed step, artifacts dir). Users own the payload (slack/teams/email script) — the kit ships no integrations.
**Lands in:** `flow.mjs` exit paths (succeeded / failed / still-running) + CONFIGURATION.md.

### 9. Agent fallback across retries — M
**Pain:** `onFailGoto` retries with the SAME agent; if an agent is systematically bad at a step (e.g. codex chokes on a repo layout), retries burn the budget identically.
**Plan:** `"agentFallback": ["codex", "claude"]` — attempt N uses agentFallback[min(N-1, len-1)]. The status page already shows the agent per attempt via `agentOf()`; wire overrides through it. Keep `--agent` flag precedence.
**Lands in:** `flow.mjs` `agentOf()` + retry bookkeeping + CONFIGURATION.md.

### 10. Batch / backlog mode — M
**Pain:** one objective per invocation; real development has a list of features.
**Plan:** `--batch <file.json>` (array of objectives, optional per-item config overrides); runs sequentially, one Orca Run per item, each with its own status snapshot (composes with #1's history); `--batch --dry-run` prints the whole plan. A top-level `batch-status.html` index links each run's page.
**Lands in:** `flow.mjs` argv/main path + CONFIGURATION.md.

---

## HORIZON 3 — Longer arc

### 11. Cross-worktree dashboard — L
One index page listing every worktree's latest run (scan known worktrees' artifacts dirs for status snapshots; render read-only summary cards linking to each worktree's own page). Turns the kit into a team wall without any server.

### 12. Cost & usage tracking — M (depends on Orca CLI surface)
Per-step wall-clock already exists; add token/usage if `orchestration` exposes it (dispatch-show/task records). Render per-step and per-agent aggregates on the page; export CSV in artifacts. Answer "which agent is worth it for which step" with data.

### 13. Checklist write-back — M
Let the page POST edits to `TASKS.md`... impossible under file:// without a server. Honest alternative: an "edit hint" (click a task → copy a Markdown snippet to paste into the file), or an opt-in tiny local HTTP listener (`--status-port`) that ONLY serves writes to checklist files. Needs a design decision on the zero-server principle — brainstorm before building.

### 14. Warm agent pool — M/L
Terminal create + quiet-detect warmup costs 12–30 s+ per step. Keep 1 warm terminal per (agent, worktree) alive across consecutive steps that use the same agent, reuse via `terminal send`, close on config change/flow end. Must respect liveness semantics (never reuse a terminal mid-dispatch).

---

## Suggested sequencing

1. **#5 first** — it is a correctness gap (fields that do nothing on the main path), not a feature; small and restores config trust.
2. **#4** — cheap insurance that makes every later config change safer.
3. **#2 + #7** — visibility pair: see artifacts and logs without leaving the page; multiplies the value of the v1.1.0 Tasks card.
4. **#3** — removes the biggest friction of long runs (manual resume).
5. **#6, #8, #9, #10** in that order — each shrinks wall-clock or supervision cost of real runs.
6. Horizon 3 items are opportunistic (#12 becomes attractive the moment Orca exposes usage data).

## Explicit non-goals (for now)

- No bundled notification integrations, no bundled Markdown renderer, no server-by-default (#13's listener would be opt-in only).
- No re-architecture of flow.mjs into modules — single-file is a feature (copy one folder, done).
- No task-level gating: the checklist stays display-only (design decision from v1.1.0, revisited only with real-world evidence).
