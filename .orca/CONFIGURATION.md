# Full configuration reference — Orca SDLC Flow Kit

All pipeline behavior lives in **`.orca/flow.config.json`**. `flow.mjs` just reads
this file and executes it — you never edit the script. This document describes every
config field, with examples for common situations.

---

## 1. Top-level structure

```jsonc
{
  "artifactsDir": ".orca/artifacts",   // where step outputs are stored
  "maxRetries": 2,                      // max retries per onFailGoto loop
  "autoRun": true,                      // fully automatic (default): no questions, no gates
  "defaults": { "timeoutMs": 900000 },  // default per-step timeout (ms)
  "pipeline": [ /* list of steps, run in array order */ ]
}
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `artifactsDir` | string | no (default `.orca/artifacts`) | Folder holding the artifact files steps write |
| `maxRetries` | number | no (default 2) | Cap on how many times a `fail -> onFailGoto` pair may loop before stopping |
| `autoRun` | boolean | no (default `true`) | `true` = fully automatic: every step's spec carries an autonomy directive (never ask the user, decide and record assumptions in the artifact) and `gate` flags are ignored. `false` = manual mode: agents may ask questions and steps with `gate:true` block on an approval gate. In auto-run, claude agents also start with permission bypass (`--permission-mode bypassPermissions`) so their terminal never waits for an approval — Claude Code asks you to accept bypass mode once per machine on first use (see the README's troubleshooting); manual mode keeps default prompting. |
| `defaults.gateTimeoutMs` | number | no (default 3600000 = 60 min) | Manual mode only: how long to wait for a decision gate to be resolved before continuing anyway |
| `defaults.timeoutMs` | number | no (default 900000 = 15 min) | Max worker **silence** (no terminal output, no heartbeat). Silence is NOT a failure verdict: a worker deep in one long tool call can look quiet for most of an hour. A quiet-but-alive dispatch is waited on (with a warning) until it settles or the hard cap hits; only a positive failure (dispatch failed / worker report) fails the step |
| `defaults.hardTimeoutMs` | number | no (default 4x `timeoutMs`) | Absolute per-step cap; on hit the worker's terminal is left open and the flow stops with a `--from` resume hint |
| `defaults.warmupTimeoutMs` | number | no (default 240000 = 4 min) | How long to wait for a freshly created agent TUI to become idle before dispatching into it (prevents `agent_prompt_stalled` on slow boots) |
| `defaults.startGraceMs` | number | no (default 90000) | After delivering a prompt, how long to watch the TUI for proof it was consumed before re-sending (some TUIs drop input pasted during boot) |
| `defaults.sendAttempts` | number | no (default 3) | Max prompt deliveries into a warmed terminal before falling back to a cold `worker-start` |
| `defaults.worktree` | string | no (default: auto-detect from the invoking directory) | Worktree selector where agents run. Leave unset for auto-detect (recommended — works whenever the flow is launched from inside an Orca-managed worktree). Pin (`name:lab2`, `path:C:\\...`) only when launching from OUTSIDE the target worktree. Per-run override: `--worktree <selector>`; per-machine: `ORCA_FLOW_WORKTREE` env. Precedence: flag > env > config > auto-detect. A pinned selector is validated before the run starts — a wrong pin fails fast with the available worktrees listed. |
| `defaults.openStatus` | boolean | no (default `true`) | Auto-open the run's live status page (`status.html` in the worktree's artifacts dir) in your browser when a real run starts. Dry-runs never write or open it. Per-run off-switch: `--no-open-status` (flag wins over config) |
| `pipeline` | array | **yes** | The steps; **array order = run order** |

---

## 2. Step structure

```jsonc
{
  "id": "coding",                // unique identifier, used for references
  "title": "Coding",             // display name in logs
  "enabled": true,               // false = SKIP this step
  "agent": "codex",              // agent that runs the step
  "writes": "CHANGES.md",        // artifact filename this step writes (in artifactsDir)
  "progress": "TASKS.md",        // (optional) task-checklist file this step keeps updated
  "reads": ["detailed-design"],  // ids of steps whose output this step needs
  "spec": "...{reads}...{out}...",// prompt given to the agent
  "onFailGoto": "coding",        // (optional) loop back here on outcome=failed
  "parallelWith": "",            // (optional) id of an EARLIER step to run concurrently with
  "gate": false,                 // (optional) true = wait for approval after the step
  "model": "",                   // (optional) claude/codex/cursor only
  "effort": "",                  // (optional) requires model
  "timeoutMs": 1800000,           // (optional) override max-silence for this step
  "hardTimeoutMs": 7200000        // (optional) absolute cap for this step (default 4x timeoutMs)
}
```

### Field details

**`id`** — unique across the whole pipeline. Other steps reference this step by its
`id` (in `reads` and `onFailGoto`). Rename the `id` and you must update everything
that points to it.

**`title`** — display only, appears in `[orca-flow]` logs. Anything goes.

**`enabled`** — `true` to run, `false` to **skip**. A skipped step is automatically
removed from later steps' `reads`, so the chain doesn't break (see section 4).

**`agent`** — an agent name from Orca's catalog. Valid values:
`claude`, `codex`, `opencode`, `gemini`, `cursor`, `grok`, plus `kiro-cli`
(Kiro's terminal chat — verified end-to-end through the flow's terminal
dispatch path; needs `kiro-cli` on PATH and logged in via `kiro-cli login`.
Unlike the catalog agents it cannot use the cold-start `worker-start` fallback,
and flags may be appended, e.g. `"kiro-cli --trust-all-tools"` for unattended runs).
(Confirm the catalog for your Orca build with `orca skills get orchestration --full`.)

A `"claude ..."` value with extra CLI flags (e.g. `"claude --model haiku"`) is supported: the flow keeps your flags and adds its own wrap — in auto-run it also appends the permission bypass unless you already set a permission flag yourself. Keep flag values free of quotes and `%` signs; the string is passed through the Windows command wrap verbatim.

**`writes`** — filename (no path) the step writes its output to. The full path is
`artifactsDir + "/" + writes`. This is what later steps read back.

**`progress`** — (optional) filename (no path) of a Markdown task checklist the
step's agent maintains inside `artifactsDir` (e.g. `TASKS.md`). While the step
runs, the orchestrator polls the file and renders every checkbox line on the
live status page: `- [ ]` not started, `- [~]` in progress, `- [x]` done
(a 2+ space indent marks a sub-task). **Display only** — it never affects step
outcomes, retries or liveness. The step's `spec` must tell the agent to write
the file and keep it current; use the `{tasks}` placeholder in the spec to
reference the path (substituted like `{out}`). The shipped configs' coding
steps (`TASKS.md` / `FIX_TASKS.md`) contain ready-to-copy wording. A missing
or malformed checklist is ignored silently — the run is never affected.

**`reads`** — array of step `id`s this step depends on. The orchestrator turns it
into a list of input files and injects it into `{reads}` in the spec. A step with
`reads: []` is a starting step (relies only on the objective you pass in).

**`spec`** — the prompt given to the agent. Three placeholders are substituted:
- `{out}` -> the path this step must write (from `writes`).
- `{reads}` -> a list of "Step title (file-path)" for the enabled inputs.
- `{tasks}` -> the path of the step's task-checklist file (from `progress`; only
  substituted when the step declares one).

The orchestrator also prepends `OVERALL OBJECTIVE: <objective>` to every spec, so
the agent always knows the overall goal regardless of where the step sits.

**`onFailGoto`** — (optional) the `id` of an earlier step. When the current step
returns `outcome=failed`, the orchestrator loops back to that step to fix things,
then resumes. Set to `null` or omit to disable. Loop count is bounded by `maxRetries`.

**`parallelWith`** — (optional) id of an **earlier** step this step runs **concurrently**
with. Both start together as one group; the first step *after* the group waits for
every member (join barrier) — typically a step that `reads` both, like `coding`
reading the two design docs. Rules (validated at startup and by `--dry-run`):

- The target must exist, be enabled, and appear earlier in the `pipeline` array.
- The group must be **contiguous**: every step declaring `parallelWith` against the
  target sits immediately after it. No chains (the target itself must not declare
  `parallelWith`). A group may hold more than two members.
- Members must be **independent**: no member may `reads` another member.
- `interactive` steps cannot join a group in manual mode (two simultaneous
  terminal interviews would interleave).
- If `--only`/`--from` drops the target from the run, the member runs sequentially
  (warning, not an error) — the resume story is unchanged: `--from uiux-design`
  picks up an existing `DETAILED_DESIGN.md` via section 4's artifact-exists rule.

Failure semantics: outcomes are handled after the whole group settles, in array
order. A hard-capped member settles as still-running (terminal left open) and the
flow stops with the usual `--from` resume hint; a `failed` member follows the
normal `onFailGoto` rules — note a retry re-runs the target's **whole group**.
Settlement is per-task (`dispatch-show --task`), so concurrent workers cannot be
confused for each other. The status page marks group members with a `∥ parallel`
chip.

**`gate`** — (optional) `true` means that after the step finishes, the orchestrator
creates a **decision gate** and prints a `gate-resolve` command; the pipeline waits
until you approve "yes" before continuing. Use for milestones needing human sign-off.
**Effective only in manual mode** (`"autoRun": false`) — with the default
`autoRun: true` gates are ignored so the pipeline runs unattended.

**`interactive`** — (optional) `true` makes the step an **interview** in manual
mode (`autoRun: false`): the agent asks you questions in its terminal — one at a
time, mostly multiple choice — to align on decisions before writing its artifact,
then confirms a numbered DECISIONS list with you. The shipped config marks
Architecture Design this way; the interview covers functional and non-functional
requirements, performance, security, scalability, database/persistence, technology
constraints, and deployment. Timeouts are raised automatically (60 min silence /
4 h hard) because the terminal idles while waiting for your answers. Like `gate`,
it is **ignored when `autoRun: true`** — the step then runs fully autonomously
and records its assumptions in the artifact instead.

**`model` / `effort`** — (optional) apply to `claude`, `codex`, `cursor` only.
`effort` (e.g. `"high"`) requires `model`. Leave empty to use the agent's default.

**`timeoutMs`** — (optional) override `defaults.timeoutMs` for this step. This is the
**max-silence** budget: the orchestrator waits in slices and keeps waiting as long as
the worker shows activity (terminal output or heartbeats). A coding run that stays
busy for an hour is waited on; a worker that goes quiet for `timeoutMs` is reported
as hung.

**`hardTimeoutMs`** — (optional) absolute cap for a busy-but-endless worker (default
`4 x timeoutMs`). On hit, the step's terminal is **left open** so it can finish, and
the flow stops with the exact `--from` command to resume once the artifact is written.

---

## 3. Recipe catalog

### 3.1. Skip one or more steps
Set `enabled: false`. Don't delete the step — leave it, disable it, re-enable later.

```jsonc
{ "id": "uiux-design",  "enabled": false, /* ... */ },
{ "id": "documentation","enabled": false, /* ... */ }
```

### 3.2. Change a step's agent (permanent)
```jsonc
{ "id": "coding", "agent": "claude", /* ... */ }
```
Temporary override for one run, no file edit:
```
node .orca/flow.mjs --agent coding=claude "..."
```

### 3.3. Pin project tools WITHOUT hard-coding the kit
The kit is stack-agnostic by default. If this project needs specifics, just add a
sentence to the `spec`:
```jsonc
{
  "id": "testing",
  "spec": "You are a testing agent. Based on {reads}, write and run tests for the changes. This project uses <your test framework>. Write {out}: ... If any test fails, report outcome=failed."
}
```
Because you edit config, not the script, each project keeps its own config while the
kit stays reusable.

### 3.4. Add a new step (e.g. Performance Test)
Insert an entry into `pipeline` at the right position, and update the `reads` of any
step that should read it:
```jsonc
{
  "id": "performance",
  "title": "Performance Test",
  "enabled": true,
  "agent": "opencode",
  "writes": "PERF_REPORT.md",
  "reads": ["coding", "testing"],
  "onFailGoto": "coding",
  "spec": "You are a performance testing agent. Based on {reads}, measure the main paths and find bottlenecks. Write {out}: method, metrics, bottlenecks, recommendations. If it exceeds the acceptable threshold, report outcome=failed to loop back to coding."
}
```

### 3.5. Reorder steps
Just move entries within the `pipeline` array. Remember the rule: a step should only
`reads` steps that come **before** it. If reordering breaks that, the orchestrator
still runs but an input may not exist yet.

### 3.6. Insert an approval gate at a milestone
```jsonc
{ "id": "architecture", "gate": true, /* ... */ }
```
After Architecture finishes, the pipeline pauses for your approval before Detailed Design.

### 3.7. Disable a step's fix loop
Set `"onFailGoto": null`. When the step fails, the pipeline stops instead of looping back.

### 3.8. Give the coding step more time
`timeoutMs` is max silence, so a busy coder is already waited on indefinitely up to
its hard cap. Raise the cap when a full implementation legitimately runs long:
```jsonc
{ "id": "coding", "hardTimeoutMs": 7200000 /* 2 h */ }
```

### 3.9. Run two steps at the same time
Independent steps that both depend on the same input can run concurrently — the
shipped config does this for the two design passes (both read Architecture,
Coding waits for both):
```jsonc
{ "id": "uiux-design", "parallelWith": "detailed-design", /* ... */ }
```
Saves the length of the shorter step; verify the grouping with `--dry-run`.

---

## 4. Skip auto-shrinks dependencies (important)

When a step is `enabled:false` (or excluded by `--only`/`--from`), the orchestrator
**automatically filters it out of every later step's `reads`** — **unless its artifact
file already exists in the worktree**. That exception is what makes `--from <id>` a
true resume: `--from coding` keeps pointing the coder at `DETAILED_DESIGN.md` /
`UIUX_MOCKS.md` produced by an earlier run. Example — disabling `security-review`
before it ever ran:

- Before: `testing.reads = ["coding","code-review","security-review"]`
- After: `testing.reads = ["coding","code-review"]`

You do **not** need to edit other steps' `reads` when skipping — the orchestrator
handles it. Always verify with `--dry-run` to see the effective `reads` after filtering.

---

## 5. Command-line flags (complement the config)

| Flag | Effect | Example |
|------|--------|---------|
| `--dry-run` | Print the pipeline, do NOT call agents | `node .orca/flow.mjs --dry-run "x"` |
| `--config <file>` | Use another pipeline config (default `flow.config.json`) | `--config fixbug.config.json` |
| `--worktree <selector>` | Pin the worktree for this run (default: auto-detect from the invoking directory) | `--worktree name:lab2` |
| `--from <id>` | Start from a step, drop earlier ones | `--from coding` |
| `--only a,b,c` | Run only the listed steps | `--only planning,architecture` |
| `--agent <id>=<agent>` | Override one step's agent, this run only | `--agent coding=claude` |
| `--grill-me` | Enable the `grill` step for this run (see section 5.2) | `--grill-me --only grill` |
| `--no-grill-me` | Disable the `grill` step for this run (see section 5.2) | `--no-grill-me` |
| `--no-open-status` | Do not auto-open the live status page for this run (see section 5.3) | `--no-open-status` |
| `--status-preview` | Write a fixture status page (`.orca/status-preview/`) showing every state — dev aid, no run, no agents. Refused when combined with an objective / `--only` / `--from` / `--agent` (before v1.0.1 that mix silently skipped the pipeline with no agent spawned) | `node .orca/flow.mjs --status-preview` |

Flags affect only that run; they are not written to the config. `enabled:false` in
config is always respected, even if that step is listed in `--only`. (Exception:
`--grill-me` / `--no-grill-me` explicitly override the `grill` step — see section 5.2.)

### 5.1. Multiple pipelines

Any config file in `.orca/` can define a pipeline — same schema, selected with
`--config`. The kit ships two:

- `flow.config.json` — full SDLC (default, no flag needed).
- `fixbug.config.json` — bug-fix flow: Root Cause Analysis (claude) -> Fix Plan
  (claude) -> Bug Fix incl. regression test (codex) -> Fix Verification against
  the original reproduction (opencode; fail loops back to the fix).

```
node .orca/flow.mjs --config fixbug.config.json "<bug: what happens, expected, how to reproduce>"
```

Pass the complete bug context as the objective — the RCA step reproduces from it.

### 5.2. The `grill` step and `--grill-me` / `--no-grill-me`

`--grill-me` enables the step whose `id` is exactly `grill` (the shipped
requirements-interview step) for this run; `--no-grill-me` disables it. Both are
shorthands for flipping that step's `enabled` field. Because the override is
applied before `--only` / `--from` are processed:

- `--grill-me --only grill,planning` works (the override lands before subsetting — argv order is irrelevant).
- `--from planning` still skips the interview — a resume must not restart it.
- When `grill` is skipped, section 4's artifact-exists exception still feeds Planning an existing `BRAINSTORM.md` — see the README's Grill-me section for when to refresh that file.
- If the config has no step with id `grill`, the flag fails with a clear error.
- The two flags are mutually exclusive.
- Renaming the step's `id` breaks the flags — keep the id `grill`.

The shipped `grill` step carries large `timeoutMs` (60 min = `3600000`) /
`hardTimeoutMs` (4 h = `14400000`): the agent terminal is idle while it waits
for a HUMAN to answer, and the 15-min default would report the step hung
mid-interview. Tune them only upward for longer interviews. A single question
left unanswered past `timeoutMs` stops the flow with the interview terminal
left open — restart the interview with `--grill-me --from grill "<objective>"`.

### 5.3. The live status page

Every real run writes a self-updating dashboard next to the artifacts:

- `<worktree>/<artifactsDir>/status.html` — open it in any browser; it refreshes itself every 2 seconds (works straight from disk — no server, no ports).
- `<worktree>/<artifactsDir>/status.js` — the snapshot the page reads; rewritten by the orchestrator at every step event.

It shows the objective, an overall badge (RUNNING / DONE / FAILED / UNKNOWN / STILL RUNNING — "still running" means the flow stopped with a step's terminal left open; resume with `--from`), a progress bar, and every pipeline step with its agent, live elapsed time, durations, retry attempts (`attempt 2`, ...), approval-gate waits (manual mode) and — at the end — the artifact list. Steps that declare a `progress` checklist also get a live **Tasks card** —
per-task `○` queued / `◐` in progress / `✓` done, read straight from the file
the step's agent ticks as it works. Until the file appears, the card shows a
waiting hint instead. Steps excluded by `enabled:false`, `--only` or `--from` render as SKIPPED, except when a previous run's history (same config) exists in the same worktree: the page then merges it, so a `--from` resume shows one continuous picture (durations of earlier steps included).

The page opens automatically when the run starts (`explorer.exe` on Windows, `open` on macOS, `xdg-open` on Linux). Turn that off with `--no-open-status`, or per-project with `"defaults": { "openStatus": false }`. If writing the page fails (e.g. a read-only folder) the run continues untouched — the dashboard never affects pipeline execution. `node .orca/flow.mjs --status-preview` renders a fixture page showing every state without a run — it cannot be combined with an objective or `--only`/`--from`/`--agent`; real runs write and open the page automatically and need no flag.

---

## 6. Environment variables

| Variable | Effect |
|----------|--------|
| `ORCA_CLI_COMMAND` | Set the orca CLI path/executable name if it can't be auto-detected |

---

## 7. Safe config-editing workflow

1. Edit `.orca/flow.config.json`.
2. Run `node .orca/flow.mjs --dry-run "test objective"` — check step order, agents,
   and effective `reads` match your intent.
3. If good, run for real. For a new project, try a small feature first.

Common JSON errors: a missing comma between entries, or a trailing comma on the last
entry. If `--dry-run` reports "Could not read flow.config.json", check those two spots.

---

## 8. Quick reference of valid values

- `agent`: `claude` · `codex` · `opencode` · `gemini` · `cursor` · `grok` · `kiro-cli`
- `enabled`: `true` · `false`
- `gate`: `true` · `false`
- `onFailGoto`: any `id` earlier in the pipeline, or `null`
- `parallelWith`: an earlier step `id` (members run concurrently; the next step waits for all)
- `reads`: array of `id`s (empty `[]` for a starting step)
- time: milliseconds (15 min = `900000`, 30 min = `1800000`)
