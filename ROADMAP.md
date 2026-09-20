# Orca SDLC Flow Kit — Roadmap

Current release: **v2.2.0** · Last updated: 2026-09-20 · Proposal only — no committed dates.

One folder, Node only, no server. All pipeline behavior lives in the JSON configs; the script stays a generic executor. Monitoring is display-only by contract: nothing on the status page can change a run's outcome, timeout or retry.

## At a glance

| Track | Milestone | Theme |
|---|---|---|
| Shipped | v2.2.0 | Parallel reviews — both reviewers at once in the shipped SDLC pipelines |
| Shipped | v2.1.0 | Nudge — auto-retry for missing artifacts |
| Shipped | v2.0.0 | Readiness gate — never launch a step on unready inputs |
| Shipped | v1.7.0 | Step-completion chat notifications |
| Shipped | v1.6.1 | E2E test suite + workflow templates |
| Shipped | v1.6.0 | Change-request (CR) maintenance pipeline |
| Shipped | v1.5.3 | Parked-prompt detection |
| Shipped | v1.5.2 | Per-harness model configuration |
| Shipped | v1.5.1 | Stability release — npx install + resume/retry/usage bug fixes |
| Shipped | v1.5.0 | Token usage tracking |
| Shipped | v1.4.0 | Status page redesign — pipeline rail + detail pane |
| Shipped | v1.3.0 | Parallel steps (`parallelWith`) |
| In focus | **v2.0.x** | Trust & visibility — finishing the v2 line |
| Queued | v2.0.x | Speed & supervision — minor releases in the v2 line |
| Later | — | The longer arc |

## Shipped

| Version | Feature | What shipped |
|---|---|---|
| v2.2.0 | **Parallel reviews** | Both shipped SDLC pipelines (`flow.config.json` + `workflow-template/sdlc.config.json`) now run code-review ∥ security-review off the same coding output — the existing `parallelWith` mechanism (v1.3.0), engine untouched: both review workers launch together, Testing stays the join barrier (reads both verdicts, readiness-gated), and either review FAILing loops back to Coding with the whole group re-running after the fix (a security fail already re-ran code-review sequentially — same doctrine, now symmetric and paid back as one round instead of two on the happy path), bounded by `maxRetries`. Known edge, engine follow-up queued (pre-existing outcome ordering, first reachable with `onFailGoto` members in a group): a definite FAIL preempts the stop for a hard-capped still-running sibling — hardening will make still-running outrank the jump. Pinned E2E by E27 (parallel fail-retry inside a review group: both members re-dispatched on retry); suite 295/295 |
| v2.1.0 | **Nudge — auto-retry for missing artifacts** | A worker that reports completion (or stalls mid-run) without writing its declared artifact now gets its own terminal nudged to write the file — reusing the warm session instead of a full re-dispatch. One shared budget per step per dispatch (`nudgeRetries` — ships at 0, opt-in by raising it; `nudgeTimeoutMs`, default 120000; per-step overridable), two triggers (mid-run: frozen preview + stale dispatch heartbeat; post-done: worker_done with the file missing). The artifact file stays ground truth: recovery settles with the original outcome, exhaustion settles failed into the onFailGoto / --from machinery. A terminal parked on a human-only dialog is never typed into — on any trigger or re-nudge. Pinned E2E by E19-E26 + F12/F12b; suite 282/282 |
| v2.0.0 | **Readiness gate — never launch a step on unready inputs** | Before each run-order group launches, every member's DECLARED `reads` are verified on disk: artifact present and ≥ `defaults.readinessMinBytes` (200) — closing both blind-start holes at once (`--from`/`--only` resumes silently dropping missing reads; a step reporting success over an empty file). Unready inputs surface at the terminal — `[y/N]` asked even in auto-run (input safety is not agent autonomy; piped/CI stdin EOF = no): decline stops the run with the exact `--from <producer>` command; accept re-runs ONLY the missing producers (singleton groups — parallel siblings untouched), TRANSITIVELY up the read chain in pipeline order, up to `defaults.readinessRetries` (3) attempts, re-dispatching only on definite outcomes (no blind retry — the double-dispatch doctrine). Reads of `enabled:false` steps are exempt (optional inputs, per the config contract). New load-time validation dies before any agent work on forward in-run reads and reads of writes-less steps (the latter previously crashed with a raw TypeError). Repaired out-of-run steps update their status rows like any other. Pinned E2E by E12-E18 + F10/F11 — including E18, the suite's first REAL run of a shipped config (default pipeline, fresh worktree, no prompt). Suite 216/216 with the v1.7.0 notifications line merged |
| v1.7.0 | **Step-completion chat notifications** | `.orca/notify.json` (shipped empty = off until filled) pushes every step settlement (succeeded/failed/still-running/unknown, retries per attempt) and one run-end summary to **Slack, Telegram, MS Teams, WhatsApp** or any `generic` JSON webhook — provider-specific payloads (Adaptive Card for Teams, Bearer + Graph API for WhatsApp). Never-block contract: delivery in a timeout-guarded child (9s abort / 12s cap), first hard failure warns once (secrets-free reason) and latches; notifications never change exit codes or settlement. Failed-run chat messages carry the console's SAFE resume hint (failed resumes from itself; a live worker from the NEXT step — no double-dispatch, mixed parallel groups included). Secrets ride stdin, never argv/logs; users gitignore the filled file. `ORCA_FLOW_NOTIFY_FILE` overrides the path; `--dry-run` announces the resolved state and sends nothing; `events` toggles step/run (`[]` = off). Pinned E2E by N1-N5 (155/155) via a localhost webhook recorder. Supersedes the queued generic-command notify item; README Contributing now requires `npm test` before pushing |
| v1.6.1 | **E2E test suite + workflow templates** | `test/` runs the real `flow.mjs` against a fake Orca CLI (`npm test`, 127 assertions, ~2-4 min, fully offline — no Orca runtime, no agents, no real Runs; every scenario watchdog-guarded so a hang fails the suite): 11 E2E scenarios pin the happy paths (cold + manual start incl. the paste ladder and AUTO-RUN claude wrap, parallel launch + join barrier), the `onFailGoto` fix loop (reopen-not-recreate, regression #2), no-blind-retry on unknown outcomes, bounded gates and `--from` resume; 9 fast-validation cases cover the shipped configs' dry-run plus load-time CLI/config guards. `.orca/workflow-template/` ships three ready-to-run variants (sdlc/fixbug/cr) ending with a git-deliver step (commit, rebase onto origin/main, smoke-test, push). Fix: a parked worker's diagnosis note now survives the hard cap into the final status (E6-pinned). Docs: README condensed with Mermaid flowcharts, troubleshooting split into `TROUBLESHOOTING.md`. `test/` is repo-side — deliberately NOT npx-shipped |
| v1.6.0 | **Change-request (CR) maintenance pipeline** | Third shipped pipeline `cr.config.json`, selected with `--config`: impact analysis on the existing code (claude) -> CR plan with a point-by-point acceptance-criteria checklist (claude) -> CR coding (codex, live checklist `CR_TASKS.md`) -> code review (claude) -> testing incl. regression on the existing suite (opencode) -> acceptance verification against the criteria (opencode); any gate FAIL loops back to the coding step (max 2 retries). CR-specific artifact names, so SDLC/fixbug/CR runs can share a worktree's artifacts dir without collisions. Pure config — `flow.mjs` untouched; shipped via npx (`package.json` `files` + `init.mjs` `FILES` in sync); README, `.orca/README` and CONFIGURATION.md now enumerate all three pipelines |
| v1.5.3 | **Parked-prompt detection** | A worker parked on a dialog only a human can answer — `permissions.ask` rules (not bypassed by `bypassPermissions`), Claude Code's folder-trust check on a fresh worktree, a CLI update prompt — is recognized from the known dialog texts on its frozen terminal screen: logged once per step per distinct prompt, with a "parked" note on the status page and the answer-it-in-the-terminal hint, instead of silence until the hard cap. Detection only — the flow never answers prompts; wait/fail semantics unchanged (#4) |
| v1.5.2 | **Per-harness model configuration** | Optional `"model"` on each step plus pipeline-wide `defaults.model` (step overrides default). `"default"` — also missing or empty — keeps the agent's own default model: nothing is passed to the CLI. Any other value is passed as `--model <value>` on the primary dispatch path (previously the field only reached the cold-start fallback) and via `worker-start --model` on the fallback. A model flag inside the `agent` string always wins; kiro-cli (no model selection) is skipped with a warning; the dry-run plan shows the effective model per step. Also: roadmap re-tracked around the v2 line (queued minors → v2.0.x) |
| v1.5.1 | **Stability release** | One-command install via `npx github:vankhangfet/orca-sdlc-kit`; bug fixes: `--from` no longer crashes at import on pipelines using `parallelWith`, `onFailGoto` fix-loops complete (settled tasks reopened before replay), and token usage reports real numbers again (Claude transcripts no longer suppressed, new Codex `token_count` records parsed without double-counting, nested subagent transcripts scanned) |
| v1.5.0 | **Token usage tracking** | After every run (success or die) token usage per step is collected from Claude Code / Codex session logs (`~/.claude/projects`, `~/.codex/sessions`), appended to `USAGE.md` in the artifacts dir, and written to the status page (`steps[].usage`, `meta.usage` — rail chips + finished-run breakdown). Spec-matching attributes parallel same-agent steps; retries count as extra attempts; agents without adapters show "—"; CSV export from the old roadmap note was dropped |
| v1.4.0 | **Status page redesign** | Two-pane dashboard: a vertical pipeline rail (status dots, purple-bracketed parallel groups, retry/NEXT/gate chips, per-step agent + duration) and a detail pane — Now running cards with big live elapsed timers, notes (quiet-but-alive, fix-from) and task mini-bars, Up next, the Tasks checklist and artifact chips with ✓; a failed run names the failed step and the exact `--from` resume command. Display-only contract and file:// polling unchanged |
| v1.3.0 | **Parallel steps** | `"parallelWith": "<id>"` runs a step concurrently with an earlier one (flat, contiguous, independent groups); per-task settlement via dispatch-show keeps concurrent workers distinct; join barrier at the next step; retries re-run the target's group. The shipped config runs detailed-design ∥ uiux-design |

## v2.0.x — trust & visibility (in focus, continuing the v2 line)

The v2 major opened with v2.0.0's readiness gate. The rest of the line is about
confidence: every option does what it says, every config mistake surfaces before
an agent starts, and everything a run did stays inspectable long after the
terminal closes.

| Feature | What changes technically | Where |
|---|---|---|
| **Settings that always take effect** | ✅ `model` done — per-step `"model"` + `defaults.model` are honored on the primary dispatch path (`"default"` = the agent's own model, nothing passed; a model flag inside the `agent` string still wins; landed on `main` post-v1.5.1). Still open: `effort` on the primary path | config fields |
| **Config validation before any agent starts** | ✅ Partially shipped (v2.0.0) — forward in-run `reads` and reads of writes-less steps die at load, in every mode (F10/F11). Still open: `reads` referencing unknown ids, `onFailGoto` pointing forward or into a cycle, unknown agent names, duplicate ids, `writes`/`progress` filename collisions | flow startup |
| **Artifact viewer** | Each step row links to the Markdown file it produced; the page lazy-loads it via the same `file://` script-polling trick as `status.js`. Styled preformatted text — no Markdown engine | status page |
| **Run log** | Every run appends to `FLOW_LOG.md` in the artifacts dir: step transitions, warnings, gate hints, durations — the console, persisted | artifact |
| **Run history** | Snapshots kept per run (`status-<runId>.js`, last 20) + a run selector on the page; "which step failed last time" answered by looking | status page |
| **Auto-resume** | `--from auto` loads the previous status snapshot + checks artifacts on disk, resumes at the first unsettled step, prints what it chose and why. Manual `--from <id>` keeps precedence | CLI flag |

## v2.0.x — speed & supervision (queued, minor releases in the v2 line)

| Feature | What changes technically | Where |
|---|---|---|
| **End-of-run notifications** | ✅ Shipped in a richer form (v1.7.0) — per-step AND run-end chat notifications via `.orca/notify.json` (slack / telegram / teams / whatsapp / generic webhook), delivered by a timeout-guarded child process with a fail-once latch and console-matching safe resume hints; the generic-command shape was superseded by bundled provider support | config file |
| **Agent fallback on retry** | `"agentFallback": ["codex", "claude"]` — attempt N uses agentFallback[N-1]; the page already shows the agent per attempt. `--agent` flag keeps precedence | config field |
| **Batch mode** | `--batch backlog.json` — array of objectives run sequentially, one Orca Run each, its own status snapshot per item; `--batch --dry-run` previews the whole queue | CLI flag |

## Later — the longer arc

| Feature | What changes technically |
|---|---|
| **Cross-worktree dashboard** | One index page scanning known worktrees' artifacts dirs; read-only summary cards linking to each worktree's own page — a team wallboard, still no server |
| **Checklist write-back** | Editing `TASKS.md` from the page requires a local listener — breaks the no-server default. Likely ships as a lighter alternative (click a task → ready-made snippet to paste). Open design decision |
| **Warm agent pool** | Reuse one warmed terminal across consecutive steps that use the same agent, instead of create + quiet-detect per step; never reused mid-dispatch |

## Sequencing rationale

1. **Trust first** — validation + the settings fix: an option that silently does nothing, and mistakes that surface mid-run, both erode confidence in everything else.
2. **Visibility** — artifact viewer, run log, history: multiply the value of the Tasks card without touching run logic.
3. **Speed & supervision** — notify, fallback, batch (parallel steps already shipped): each shrinks wall-clock or human attention per run.

## Not building (by design)

- **A server or installer** — single copy-paste folder, Node only; any future local listener would be opt-in and off by default.
- **Bundled integrations beyond plain webhooks** — chat notifications ship as best-effort webhook POSTs (`.orca/notify.json`); what stays out by design: email, OAuth/SDK platform apps, interactive cards. Plain text to endpoints you own is the whole surface.
- **Checklist gating** — the task checklist stays a live view; the run never waits on checkbox state.
- **A multi-file rewrite** — `flow.mjs` stays one script; one folder you copy is the product.

---

*Where-column legend:* **config field** = editable in `.orca/*.config.json` · **CLI flag** = `node .orca/flow.mjs` option · **status page** = rendered from `status.js` · **artifact** = file in the worktree's artifacts dir · **flow startup** = executor logic in `flow.mjs`.
