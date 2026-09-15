# Workflow templates

Ready-made variants of the three shipped pipelines that **finish the delivery**:
after the flow's last step passes, a final **Rebase & Push** step (`git-deliver`)

1. commits any pending work (creating a kebab-case working branch first if HEAD
   is on `main`/detached),
2. `git fetch origin`,
3. rebases onto the integration branch — resolving conflicts itself,
4. smoke-runs the test suite **only if** it resolved conflicts,
5. pushes with `git push -u origin HEAD`.

It never force-pushes, and a delivery failure does NOT loop back to coding — it
stops and shows on the status page for a human to decide.

| Template | Based on | Run with |
|---|---|---|
| `sdlc.config.json` | `flow.config.json` | `node .orca/flow.mjs --config workflow-template/sdlc.config.json "<objective>"` |
| `fixbug.config.json` | `fixbug.config.json` | `node .orca/flow.mjs --config workflow-template/fixbug.config.json "<bug + reproduction steps>"` |
| `cr.config.json` | `cr.config.json` | `node .orca/flow.mjs --config workflow-template/cr.config.json "<what changes and why>"` |

## Customize

- **Integration branch** — the `git-deliver` spec rebases onto `origin/main`.
  On a different branch (e.g. `develop`), replace every `origin/main` in that
  step's `spec` text.
- Everything else (steps, agents, models, retries, timeouts) is ordinary
  config — see [`../CONFIGURATION.md`](../CONFIGURATION.md).
- These templates are copies: editing them never affects the base configs,
  and vice versa.

## Artifacts

`git-deliver` writes its report next to the other artifacts: `DELIVERY.md`
(sdlc), `FIX_DELIVERY.md` (fixbug), `CR_DELIVERY.md` (cr) — branch, commits
pushed, conflicts resolved, smoke-check result, PR-style summary.
