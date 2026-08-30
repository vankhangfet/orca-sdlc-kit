# Orca SDLC Flow Kit

Orchestrate a complete software development lifecycle inside Orca ADE — one AI agent per step, every step toggleable via a single config file. Cross-platform (Windows / macOS / Linux), runs on Node only.

## Why use it

- **Full lifecycle, automated** — from requirements to documentation, unattended by default (`autoRun`); flip one switch for interview/approval modes.
- **Best agent for each job** — mix Claude, Codex, OpenCode, Gemini, Cursor, Droid, Grok per step.
- **Quality loops built in** — review, security, and test failures automatically loop back to coding (capped by `maxRetries`).
- **Stack-agnostic** — specs describe general principles, no language or framework assumptions.
- **Config-driven** — skip, reorder, add steps, or swap agents by editing one JSON file.

## Pipelines

### Full SDLC (`flow.config.json`)

| # | Step | Agent | Writes | On fail |
|---|------|-------|--------|---------|
| 0* | Grill Me (interview, opt-in) | claude | BRAINSTORM.md | — |
| 1 | Planning | claude | PLAN.md | — |
| 2 | Architecture Design † | claude | ARCHITECTURE.md | — |
| 3 | Detailed Design | claude | DETAILED_DESIGN.md | — |
| 4 | UI/UX Design | claude | UIUX_MOCKS.md | — |
| 5 | Coding | codex | CHANGES.md | — |
| 6 | Code Review | claude | REVIEW.md | back to 5 |
| 7 | Security Review | claude | SECURITY_REVIEW.md | back to 5 |
| 8 | Testing | opencode | TEST_REPORT.md | back to 5 |
| 9 | Documentation | claude | DOCUMENTATION.md | — |

\* Disabled by default; enable per run with `--grill-me` or permanently in config.
† In manual mode (`autoRun: false`) this step interviews you before designing — see [Automation modes](#automation-modes--autorun).

Steps pass data via artifact files in `.orca/artifacts/`. A skipped step is auto-removed from later steps' `reads` — the chain stays intact.

### Bug fix (`fixbug.config.json`)

Root Cause Analysis -> Fix Plan -> Bug Fix -> Fix Verification (loops back on failure, max 2 retries).

```
node .orca/flow.mjs --config fixbug.config.json "<symptom, expected behavior, reproduction steps>"
```

## Automation modes — `autoRun`

One top-level switch controls how much the pipeline involves you:

```jsonc
"autoRun": true   // default — set to false for manual mode
```

| | `"autoRun": true` (default) | `"autoRun": false` (manual) |
|---|---|---|
| Agents | Run unattended — never ask, never wait for a human | May ask you questions in their terminal |
| Ambiguity | Agent decides, records assumptions in the artifact | Discussed and confirmed with you |
| Steps with `"gate": true` | Ignored | Pause the pipeline for your approval |
| Steps with `"interactive": true` (Architecture) | Run autonomously | Interview you before writing the artifact |
| Typical use | Overnight / batch runs | High-stakes work needing sign-off |

**Auto-run (default).** Every step's spec carries an autonomy directive: *do not ask the user, do not wait for confirmation — decide with best judgment and record every decision under an "Assumptions & decisions" section in the artifact.* You audit afterwards instead of babysitting. Gates are ignored, so nothing ever blocks on a human.

**Manual mode.** Agents may ask in their terminal. On top of that, two per-step opt-ins become active (both are ignored in auto-run):

- **`"interactive": true` — structured interview.** The agent asks one question at a time (mostly multiple choice), restates each answer so you can correct it early, then confirms a numbered DECISIONS list before writing its artifact. The shipped config marks **Architecture Design** this way: the interview covers functional & non-functional requirements, performance targets and expected load, security & compliance, scalability, database/persistence, technology constraints, and deployment. Timeouts are raised automatically (60 min silence / 4 h hard) because the terminal idles while waiting for your answers. Add `"interactive": true` to any other step to get the same behavior.
- **`"gate": true` — approval gate.** After the step finishes, the flow prints a `gate-resolve` command and waits (up to `defaults.gateTimeoutMs`, 60 min by default) for you to approve before continuing.

The only exception in both modes is the opt-in **Grill Me** step (`--grill-me`): it is an interview by design and always interactive.

## Setup

1. Copy `orca.yaml` and the `.orca/` folder into your project root.
2. Add `.orca/artifacts/` to your `.gitignore`.
3. In Orca: Settings -> Experimental -> enable **Orchestration**. Verify with `orca status --json`.
4. Create a worktree in Orca (the hook scaffolds `.orca/artifacts`). For an existing worktree:
   ```
   node -e "require('fs').mkdirSync('.orca/artifacts',{recursive:true})"
   ```

Optional Orca button — Settings -> Quick Commands (scope **Project**):
`Run SDLC flow` -> `node .orca/flow.mjs "Objective"`

## Pipeline configuration — `.orca/flow.config.json`

- **Automation level** — one switch, `"autoRun"` (default `true`); see [Automation modes](#automation-modes--autorun) above. Gates and interactive interviews only apply in manual mode.
- **Skip a step** — `"enabled": false`.
- **Worktree** — agents run in the Orca worktree containing the folder you launch from (auto-detect, the default). Pin `defaults.worktree` only when launching from outside the target; `--worktree <selector>` (per run) or `ORCA_FLOW_WORKTREE` (per machine) override. A wrong pin fails fast before any agent starts.
- **Swap an agent** — edit `"agent"` (claude, codex, opencode, gemini, cursor, droid, grok).
- **Change what a step does** — edit `"spec"`; `{out}` = output file, `{reads}` = input files.
- **Add / remove / reorder steps** — edit the `"pipeline"` array; order = run order. Required fields: `id`, `title`, `enabled`, `agent`, `writes`, `reads`, `spec`. Optional: `onFailGoto`, `gate`, `interactive`, `model`/`effort`, `timeoutMs`.
- **Fix loop** — `onFailGoto: "coding"` jumps back on failure; `maxRetries` caps loops; `null` disables.
- **Manual approval** — `"gate": true` (manual mode only) pauses the pipeline until you approve via the printed `gate-resolve` command.

Full field reference: [`.orca/CONFIGURATION.md`](.orca/CONFIGURATION.md).

## Key commands

```bash
# Run the full pipeline
node .orca/flow.mjs "Build a login page"

# Preview the pipeline without calling agents (always do this first)
node .orca/flow.mjs --dry-run "Build a login page"

# Start from / run only specific steps
node .orca/flow.mjs --from coding "Continue after design"
node .orca/flow.mjs --only planning,architecture "Design phase only"

# Interactive requirements interview first
node .orca/flow.mjs --grill-me "Feature idea"
node .orca/flow.mjs --grill-me --only grill "Brainstorm session only"

# Manual mode (approval gates + Architecture interview):
# set "autoRun": false in .orca/flow.config.json, then run normally

# Override an agent for one run / use another pipeline
node .orca/flow.mjs --agent coding=claude "Objective"
node .orca/flow.mjs --config fixbug.config.json "Bug description"

# Pin the worktree (only when launching from outside the target worktree)
node .orca/flow.mjs --worktree name:lab "Objective"
```

Troubleshooting: check current CLI flags with `orca skills get orchestration --full`; reset stale orchestration state with `orca orchestration reset --all --json`.

**Claude agent crashes with `EBADF ... history.jsonl.lock` (Windows)** — known Claude Code bug ([#15739](https://github.com/anthropics/claude-code/issues/15739)): the CLI's file watcher races the create/delete of `~/.claude/history.jsonl.lock`, crashing when several Claude instances run at once. The flow already spawns claude agents with `CLAUDE_CODE_SKIP_PROMPT_HISTORY=true` (no prompt history -> no lock churn). If it still happens, close other Claude Code sessions while an interactive `--grill-me` step is running, or update Claude Code.

## License

[MIT](LICENSE)
