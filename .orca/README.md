# Orca SDLC Flow Kit

Orchestrates a full software development lifecycle inside Orca ADE — one agent per
step, **each step toggleable via config**. Cross-platform (Windows/macOS/Linux),
runs on Node (already required by Orca).

## Default pipeline (9 steps)

| # | Step | Agent | Reads | Writes |
|---|------|-------|-------|--------|
| 1 | Planning | claude | — | PLAN.md |
| 2 | Architecture Design | claude | 1 | ARCHITECTURE.md |
| 3 | Detailed Design | claude | 2 | DETAILED_DESIGN.md |
| 4 | UI/UX Design (mockscreen) | claude | 1,2 | UIUX_MOCKS.md |
| 5 | Coding | codex | 3,4 | CHANGES.md |
| 6 | Code Review | claude | 5,3 | REVIEW.md · fail -> back to 5 |
| 7 | Security Review | claude | 5,2 | SECURITY_REVIEW.md · fail -> back to 5 |
| 8 | Testing | opencode | 5,6,7 | TEST_REPORT.md · fail -> back to 5 |
| 9 | Documentation | claude | all | DOCUMENTATION.md |

Specs are **not tied to a specific stack** — they mention no language or framework
and describe general principles so they work on any project. To force a specific
tool, add it to that step's `spec` (e.g. "run tests with pytest").

Data passes between steps via artifact files in `.orca/artifacts/`.

## Bug-fix pipeline (`fixbug.config.json`)

A second, developer-facing pipeline for fixing reported bugs — root cause first,
then a reviewed fix that is verified against the original reproduction:

| # | Step | Agent | Reads | Writes |
|---|------|-------|-------|--------|
| 1 | Root Cause Analysis | claude | — | ROOT_CAUSE.md |
| 2 | Fix Plan | claude | 1 | FIX_PLAN.md |
| 3 | Bug Fix (code + regression test) | codex | 1,2 | FIX_CHANGES.md |
| 4 | Fix Verification | opencode | 3,1 | VERIFICATION.md · fail -> back to 3 |

```
node .orca/flow.mjs --config fixbug.config.json "<what happens, expected behavior, how to reproduce>"
```

Pass the full bug context as the objective — step 1 reproduces from it. If verification
still reproduces the bug (or a test fails), step 4 loops back to the fix (max 2 retries).

## Install into a project

1. Copy `orca.yaml` (repo root) and the `.orca/` folder into your project.
2. `echo ".orca/artifacts/" >> .gitignore`
3. Orca -> Settings -> Experimental -> enable **Orchestration**. Verify `orca status --json`.
4. Create a new worktree in Orca (the hook creates `.orca/artifacts`). For an
   existing worktree: `node -e "require('fs').mkdirSync('.orca/artifacts',{recursive:true})"`

## Run

```
node .orca/flow.mjs "Feature / objective description"
```

Useful flags:

| Flag | Meaning |
|------|---------|
| `--dry-run` | Print the pipeline WITHOUT calling agents. Use to check config. |
| `--config <file>` | Use another pipeline config. E.g. `--config fixbug.config.json`. |
| `--from <id>` | Start from a step (skip earlier ones). E.g. `--from coding`. |
| `--only a,b` | Run only a subset of steps. E.g. `--only planning,architecture`. |
| `--agent <id>=<agent>` | Override one step's agent for this run. E.g. `--agent coding=claude`. |

Examples:
```
node .orca/flow.mjs --dry-run "Build a login page"
node .orca/flow.mjs --from coding "Continue after design is done"
node .orca/flow.mjs --only planning,architecture,detailed-design "Design phase only"
```

## Configure — edit `.orca/flow.config.json`

### Skip a step
Set `"enabled": false`. A skipped step is **auto-removed from later steps' `reads`**
— the chain stays intact. E.g. drop UI/UX:

```json
{ "id": "uiux-design", "enabled": false, ... }
```

### Change a step's agent (permanent)
Edit `"agent"`. Values: claude, codex, opencode, gemini, cursor, droid, grok.

### Change what a step does
Edit `"spec"`. Inside a spec, `{out}` = the file this step writes, `{reads}` = the
list of input files (built from the enabled steps). Name your project's tools if
needed (e.g. "run tests with pytest").

### Add / remove / reorder steps
Add or remove entries in the `"pipeline"` array. Array order = run order. Each step
needs: `id`, `title`, `enabled`, `agent`, `writes` (filename), `reads` (array of
other step ids), `spec`. Optional: `onFailGoto` (id to loop back to on failure),
`gate` (true = wait for approval after the step), `model`/`effort`, `timeoutMs`.

### Fix loop
`onFailGoto: "coding"` sends the step back to Coding when it returns outcome=failed.
`maxRetries` (top-level config) caps the number of loops. Set `onFailGoto: null` to disable.

### Manual approval gate
`"gate": true` on a step: after it finishes, the script creates a decision gate and
prints a `gate-resolve` command to approve before continuing.

## Button in Orca

Settings -> Quick Commands -> scope **Project**:
- Label: `Run SDLC flow`
- Command: `node .orca/flow.mjs "Objective"`

## Troubleshooting

CLI flags evolve with the Orca version. Run `orca skills get orchestration --full`
to check. The script is tolerant of JSON key names (tries `taskId/task_id/id`,
`outcome/result`, ...). Reset when experiments get messy:
`orca orchestration reset --all --json`.

Always run `--dry-run` before a real run to confirm the pipeline is as expected.

See **CONFIGURATION.md** for the full field reference.
