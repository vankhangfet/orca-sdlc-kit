# Grill-Me Phase — Design Spec

**Date:** 2026-08-29
**Status:** Approved (pending implementation)
**Scope:** `.orca/flow.config.json`, `.orca/flow.mjs`, `.orca/README.md`, `.orca/CONFIGURATION.md`

## 1. Problem

The SDLC pipeline (flow.config.json) starts at `planning` with nothing but the raw
one-line objective. Feature ideas enter the pipeline unchallenged: no interview, no
scope negotiation, no confirmed decisions. Users who want a brainstorm/refinement
phase before planning have no supported way to run one, and no way for the user to
interact with an agent during it.

## 2. Goal

Add a configurable, opt-in "grill-me" phase: an agent interviews the user in its
Orca terminal, confirms every decision with them, and writes a `BRAINSTORM.md`
artifact that downstream steps (starting with `planning`) consume as input.

## 3. Decisions (locked with user)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Placement | First step of `pipeline[]` in flow.config.json (id `grill`), standing before `planning`. Not a pre-run script phase, not a standalone mode. |
| 2 | Interaction model | Agent interviews the user directly inside its own TUI (user types answers into the Orca-managed terminal). No gates, no orchestrator-driven prompts. |
| 3 | Config surface | Step defined fully in config + CLI flags `--grill-me` / `--no-grill-me` that override the step's `enabled` field. |
| 4 | Default state | `enabled: false` in shipped flow.config.json (opt-in; does not change behavior of existing runs). |
| 5 | Flag mechanics | Hard-coded named flags in flow.mjs toggling the step with `id === "grill"` (documented convention). No generic `--enable/--disable`, no per-step `flag` field. |
| 6 | fixbug pipeline | Unchanged. Bug-fix objectives are already focused; grill is a feature-design tool. |

## 4. Architecture

```
[grill: interview in agent TUI] → writes BRAINSTORM.md → [planning] → ...
        opt-in via --grill-me            artifact passing via
        or enabled:true in config        reads (existing mechanism)
```

- The grill step is an ordinary pipeline step: `task-create` → manual/cold start →
  settle on `worker_done` → artifact written to `artifactsDir`. Zero new runtime
  concepts in the execution path.
- The user participates by typing into the agent's Orca terminal — the same
  terminal the orchestrator types the preamble into. The settle loop already
  tolerates long quiet periods up to the step's `timeoutMs` (`question` /
  `escalation` events are logged and do not settle the step, flow.mjs:493-497).
- `planning` adds `"grill"` to its `reads`. `renderSpec()` injects the artifact
  path into planning's prompt automatically (flow.mjs:107-116). When grill is
  disabled and no `BRAINSTORM.md` exists, `effectiveReads()` drops the read
  (flow.mjs:97-104) — no downstream change is visible.

## 5. Changes

### 5.1 `.orca/flow.config.json`

New step at index 0 of `pipeline[]`:

```json
{
  "id": "grill",
  "title": "Grill Me (requirements interview)",
  "enabled": false,
  "agent": "claude",
  "writes": "BRAINSTORM.md",
  "reads": [],
  "timeoutMs": 3600000,
  "hardTimeoutMs": 14400000,
  "spec": "<interview spec, see 5.2>"
}
```

`planning` step: add `"grill"` as the first entry of its `reads`.

Timeout rationale (mandatory, not style): the agent TUI is idle while waiting for
a human to answer. Default `timeoutMs` (15 min max-silence) can kill the step
mid-interview. 60 min silence allowance catches an abandoned interview; the 4 h
absolute cap (the kit's 4x convention) keeps a long but ACTIVE interview from
being hard-killed; users can override per-step like any other step field.

### 5.2 Grill step spec (full text)

```
You are running an interactive REQUIREMENTS INTERVIEW ("grill me") for the
objective above. Your job: interrogate the user IN THIS TERMINAL until the idea
is concrete enough to design and plan.

Interview protocol — follow exactly:
1. Ask ONE question at a time and WAIT for the user's answer in this terminal
   before asking the next. Never batch questions.
2. Prefer multiple choice (a/b/c/...) over open-ended questions. Open-ended is
   fine only when options would bias the answer.
3. Cover, in roughly this order: purpose and success criteria; scope (explicitly
   in/out); users and UX expectations; technical/business constraints; edge
   cases; risks; open decisions that planning cannot make alone.
4. After each answer, restate your understanding in one short line so the user
   can correct you early.
5. When you have enough information, present a numbered DECISIONS list (each:
   decision + rationale) and ask the user to confirm or edit each one. Do not
   proceed until every line is confirmed.
6. This phase is REQUIREMENTS ONLY. Do not write code, tests, or detailed
   technical design.

When all decisions are confirmed, write the result to {out} with exactly these
sections:
# Brainstorm - <overall objective>
## Objective (refined)          — 1-3 sentences, agreed with the user
## Decisions                    — numbered; each with rationale and "confirmed by user"
## Scope                        — two lists: In / Out
## Constraints & assumptions
## Open questions               — only if any remain; each with why it blocks nothing
Then finish and report success.
```

### 5.3 `.orca/flow.mjs` (~12 lines)

1. **Argv parsing** (flow.mjs:44-60 block): `--grill-me` sets `opt.grillMe = true`;
   `--no-grill-me` sets `opt.grillMe = false`. Mixed pair (`--grill-me` with
   `--no-grill-me`) → die mutually-exclusive; repeating the same flag is
   idempotent.
2. **After config load, before pipeline normalization** (between flow.mjs:66 and
   flow.mjs:74): if `opt.grillMe !== undefined`, find the step with
   `id === "grill"`. Missing → `die('--grill-me/--no-grill-me: <config> has no step with id "grill"')`.
   Present → set `step.enabled = opt.grillMe`.
3. Nothing else. `isEnabled()`, `--only`, `--from`, `effectiveReads()`,
   `printPlan()`, `runStep()`, gate and onFailGoto logic are untouched and pick up
   the override naturally because it is applied before they run.

Precedence notes (documented, not new code):
- `--grill-me` flips `enabled` itself, so it composes with `--only grill,planning`.
- `--from planning` slices steps after the enable override, so it skips grill —
  correct resume semantics (resume must not restart an interview).
- Config `enabled: false` still beats `--only` when no flag is given (existing
  rule unchanged).

### 5.4 `.orca/README.md`

- Add grill row to the pipeline table, marked optional (opt-in via `--grill-me`).
- Flags section: document `--grill-me` / `--no-grill-me`.
- New recipe "Brainstorm-only session":
  `node .orca/flow.mjs --grill-me --only grill "<objective>"`
  → run the interview, stop; `BRAINSTORM.md` persists; a later full run's
  `planning` picks it up via `effectiveReads` (artifact-exists rule).

### 5.5 `.orca/CONFIGURATION.md`

- Flags table: the two new flags + precedence vs `enabled`/`--only`/`--from`.
- Step schema note: `--grill-me` toggles the step whose `id` is `grill`; renaming
  the step id breaks the flag (die message covers it).
- Document why grill ships with large `timeoutMs`/`hardTimeoutMs`.

## 6. Edge cases

| Case | Behavior |
|------|----------|
| `--grill-me --no-grill-me` together | die, mutually exclusive |
| flag given, no `grill` step in config | die with hint |
| `enabled:false`, `--only grill`, no flag | step skipped (existing config-beats-`--only` rule) |
| user answers slowly | 60 min silence absorbed; 4 h hard cap → `still-running` → script prints resume command (existing path) |
| agent emits `question` events mid-interview | logged only, step stays alive (existing, desired) |
| stale `BRAINSTORM.md` from an old run | consumed by planning unless user deletes it — same rule as every other artifact today |
| `--dry-run --grill-me` | plan shows grill enabled; nothing executes |

## 7. Verification plan

No test framework exists in this workspace (config-only kit, Node stdlib). The
contract check is a dry-run matrix plus syntax check:

1. `node --check .orca/flow.mjs`
2. `node .orca/flow.mjs --dry-run "x"` → grill listed as skipped; planning reads
   do NOT include BRAINSTORM.md
3. `node .orca/flow.mjs --dry-run --grill-me "x"` → grill first, enabled;
   planning reads include grill
4. Config temporarily `enabled: true` + `--dry-run --no-grill-me "x"` → skipped
5. `--dry-run --grill-me --only grill "x"` → only grill runs
6. `--dry-run --grill-me --no-grill-me "x"` → dies with the exclusive-flags error
7. `--dry-run --from planning --grill-me "x"` → grill sliced off (documented)

## 8. Out of scope

- Fixing the gate non-polling discrepancy (flow.mjs:570-575) — separate issue,
  flagged during review.
- Adding grill to fixbug.config.json.
- Orchestrator-side interactive prompts (stdin) of any kind.
- Generic `--enable/--disable` flags.
