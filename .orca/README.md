# `.orca/` — the SDLC Flow Kit engine

This folder is the whole kit. Copy it (together with `orca.yaml` from the repo
root) into your project and run:

```
node .orca/flow.mjs "Your objective"
```

| File | What it is |
|------|------------|
| `flow.mjs` | The orchestrator — reads the config, drives the agents. You never edit it. |
| `flow.config.json` | The full SDLC pipeline. **This is the file you edit**: steps, agents, `autoRun`, gates, interactive steps, timeouts. |
| `fixbug.config.json` | The bug-fix pipeline (run with `--config fixbug.config.json "<bug + reproduction steps>"`). |
| `CONFIGURATION.md` | Field-by-field reference for both config files. |
| `artifacts/` | Runtime output — every step's Markdown artifact lands here (gitignored). |

For the full picture — concepts, quick start, automation modes, worktree
handling, cheat sheet, troubleshooting — read the repo root **README.md**.
