# Troubleshooting

Things that can trip a run, and what to do about each. For the big picture see
the [README](README.md); for every config field see
[`.orca/CONFIGURATION.md`](.orca/CONFIGURATION.md).

- **Preview first** — `--dry-run` shows exactly what will run. Always try it
  before a real run.

- **One-time "accept responsibility" dialog (claude)** — asked once per
  machine on the first bypass session; accept it once, or pre-set
  `"skipDangerousModePermissionPrompt": true` in user-level Claude Code
  settings. Bypass = full tool access, which is why unattended pipelines
  belong in disposable Orca worktrees (the default here).

- **A step looks quiet for a long time** — silence is not failure: a worker
  deep in one long verification (reviews routinely run an hour) is waited on
  until it settles or its hard cap hits; the fix loop triggers only on a
  definite FAIL verdict, never on silence.

- **An agent is PARKED on a prompt** — `bypassPermissions` does not bypass
  your machine's `permissions.ask` rules, and Claude Code's folder-trust
  check on a fresh worktree also waits for a human (default is *exit*). The
  flow reads the agent's screen: a known dialog (permission confirmation,
  folder-trust, CLI update) on a frozen screen is logged once and noted on
  the status page — answer it in that terminal and the run continues on its
  own. The flow never answers prompts for you; accept folder-trust once per
  repo.

- **A step is taking forever** — shown as STILL RUNNING; the terminal is
  left open and the flow prints the exact `--from <step>` command to
  continue later.

- **Stale orchestration state after experiments** —
  `orca orchestration reset --all --json`.

- **CLI flags differ on your Orca version** — check
  `orca skills get orchestration --full`.

- **Claude crashes with `EBADF ... history.jsonl.lock` (Windows)** — known
  Claude Code bug
  ([#15739](https://github.com/anthropics/claude-code/issues/15739)); the
  flow already spawns Claude agents in a way that avoids it. If it recurs:
  close other Claude sessions during interactive steps, or update Claude
  Code.

## Notifications

- **`[notify] disabled: ...` appears once and nothing else is sent** — the first delivery failed (`HTTP <status>`, connection refused, timeout). The latch is intentional: a dead or slow endpoint cannot stack timeouts against the run. Fix the `url`/credentials in `.orca/notify.json` and re-run; the run itself was never affected.
- **`[notify] disabled: notify.json unreadable (...)` / `"url" is not a valid URL` / `unknown provider` / `... needs "chatId"`** — the file is filled in but invalid; check the provider table in `.orca/CONFIGURATION.md` §9. The pipeline ran normally without notifications.
- **Nothing is sent and nothing is warned** — the default-off state: `notify.json` is missing or has empty `provider`/`url`. `--dry-run` prints the resolved state (`Notifications: on/off ...`).
- **Notifications feel slow / a healthy endpoint adds lag** — each event pays one synchronous round-trip; set `"events": ["run"]` to pay it once per run instead of per step.
- **No notification on the last message of a failed run?** Delivery is attempted before the flow exits — if it still did not arrive, the endpoint rejected it (check the one `[notify]` warning; `HTTP 401` usually means a bad token) or the platform dropped it.
