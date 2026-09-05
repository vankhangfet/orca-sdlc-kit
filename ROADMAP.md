# Orca SDLC Flow Kit — Roadmap

Current release: **v1.5.0** · Last updated: 2026-09-05 · Proposal only — no committed dates.

One folder, Node only, no server. All pipeline behavior lives in the JSON configs; the script stays a generic executor. Monitoring is display-only by contract: nothing on the status page can change a run's outcome, timeout or retry.

## At a glance

| Track | Milestone | Theme |
|---|---|---|
| Shipped | v1.5.0 | Token usage tracking |
| Shipped | v1.4.0 | Status page redesign — pipeline rail + detail pane |
| Shipped | v1.3.0 | Parallel steps (`parallelWith`) |
| In focus | **v2.0** | Trust & visibility — the next major |
| Queued | v1.4+ | Speed & supervision — minor releases |
| Later | — | The longer arc |

## Shipped

| Version | Feature | What shipped |
|---|---|---|
| v1.5.0 | **Cost & usage tracking** | After every run (success or die) token usage per step is collected from Claude Code / Codex session logs (`~/.claude/projects`, `~/.codex/sessions`), appended to `USAGE.md` in the artifacts dir, and written to the status page (`steps[].usage`, `meta.usage` — rail chips + finished-run breakdown). Spec-matching attributes parallel same-agent steps; retries count as extra attempts; agents without adapters show "—" |
| v1.4.0 | **Status page redesign** | Two-pane dashboard: a vertical pipeline rail (status dots, purple-bracketed parallel groups, retry/NEXT/gate chips, per-step agent + duration) and a detail pane — Now running cards with big live elapsed timers, notes (quiet-but-alive, fix-from) and task mini-bars, Up next, the Tasks checklist and artifact chips with ✓; a failed run names the failed step and the exact `--from` resume command. Display-only contract and file:// polling unchanged |
| v1.3.0 | **Parallel steps** | `"parallelWith": "<id>"` runs a step concurrently with an earlier one (flat, contiguous, independent groups); per-task settlement via dispatch-show keeps concurrent workers distinct; join barrier at the next step; retries re-run the target's group. The shipped config runs detailed-design ∥ uiux-design |

## v2.0 — trust & visibility (in focus)

The next major is about confidence: every option does what it says, every config
mistake surfaces before an agent starts, and everything a run did stays
inspectable long after the terminal closes.

| Feature | What changes technically | Where |
|---|---|---|
| **Settings that always take effect** | `model` / `effort` step fields are honored on the primary dispatch path (today only the cold-start fallback reads them — a fix, not a feature) | config fields |
| **Config validation before any agent starts** | Rejects: `reads` referencing unknown ids, `onFailGoto` pointing forward or into a cycle, unknown agent names, duplicate ids, `writes`/`progress` filename collisions. Runs in every mode, not just `--dry-run` | flow startup |
| **Artifact viewer** | Each step row links to the Markdown file it produced; the page lazy-loads it via the same `file://` script-polling trick as `status.js`. Styled preformatted text — no Markdown engine | status page |
| **Run log** | Every run appends to `FLOW_LOG.md` in the artifacts dir: step transitions, warnings, gate hints, durations — the console, persisted | artifact |
| **Run history** | Snapshots kept per run (`status-<runId>.js`, last 20) + a run selector on the page; "which step failed last time" answered by looking | status page |
| **Auto-resume** | `--from auto` loads the previous status snapshot + checks artifacts on disk, resumes at the first unsettled step, prints what it chose and why. Manual `--from <id>` keeps precedence | CLI flag |

## v1.4+ — speed & supervision (queued, minor releases)

| Feature | What changes technically | Where |
|---|---|---|
| **End-of-run notifications** | `"notify": {"onEnd": "<cmd>", "onFail": "<cmd>"}` — executed argv-safe (no shell), with status/objective/failed-step/artifacts-dir as env vars. No bundled integrations; you plug in your own webhook/script | config field |
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
- **Bundled integrations** — no built-in chat/email/webhook targets; you connect your own.
- **Checklist gating** — the task checklist stays a live view; the run never waits on checkbox state.
- **A multi-file rewrite** — `flow.mjs` stays one script; one folder you copy is the product.

---

*Where-column legend:* **config field** = editable in `.orca/*.config.json` · **CLI flag** = `node .orca/flow.mjs` option · **status page** = rendered from `status.js` · **artifact** = file in the worktree's artifacts dir · **flow startup** = executor logic in `flow.mjs`.
