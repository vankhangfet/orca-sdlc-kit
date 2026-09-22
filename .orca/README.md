# `.orca/` — the SDLC Flow Kit engine

This folder is the whole kit. Copy it (together with `orca.yaml` from the repo
root) into your project and run:

```
node .orca/flow.mjs "Your objective"
```

Installed via `npx github:vankhangfet/orca-sdlc-kit`? You already have all of this.

| File | What it is |
|------|------------|
| `flow.mjs` | The orchestrator — reads the config, drives the agents. You never edit it. |
| `designer.mjs` | Workflow Designer — local UI server (`node .orca/designer.mjs`); builds/edits the config files visually. Opt-in, localhost-only. |
| `designer.html` | The designer's page (served by `designer.mjs` — open the printed URL). |
| `flow.config.json` | The full SDLC pipeline. **This is the file you edit**: steps, agents, `autoRun`, gates, interactive steps, timeouts. |
| `fixbug.config.json` | The bug-fix pipeline (run with `--config fixbug.config.json "<bug + reproduction steps>"`). |
| `cr.config.json` | The change-request pipeline (run with `--config cr.config.json "<what changes and why>"`). |
| `workflow-template/` | Variants of the three pipelines that END with a Rebase & Push step (commit, rebase, push). Run with `--config workflow-template/<file>`. |
| `notify.json` | Chat notifications (Slack/Telegram/Teams/WhatsApp/generic) — empty = off; see CONFIGURATION.md §9 |
| `CONFIGURATION.md` | Field-by-field reference for all three config files. |
| `artifacts/` | Runtime output — every step's Markdown artifact lands here (gitignored). |

- **Per-agent skills & MCP servers** — declare a `skills` / `mcpServers` registry in any pipeline config, reference them from steps, and each agent harness gets its standard config files in the worktree (`.mcp.json`, `.claude/skills/`, `AGENTS.md` sections, ...) — restored after every step group. See "Skills & MCP servers" in `CONFIGURATION.md`.

For the full picture — concepts, quick start, automation modes, worktree
handling, cheat sheet, troubleshooting — read the repo root **README.md**.
