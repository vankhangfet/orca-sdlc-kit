# Orca SDLC Flow Kit — Roadmap

Last updated: 2026-09-03

The Orca SDLC Flow Kit turns one sentence — "build a login page with email
sign-in" — into a working, reviewed and documented implementation: a team
of AI agents plans, designs, codes, reviews, tests and documents the
feature while you follow along on a live status page. Version 1.1.0 just
added per-task progress to that page. This roadmap describes what we
intend to add next.

Plans may change as we learn, and nothing below is a promised date or a
committed release.

## The order, briefly

Trust comes first: the first two items close silent gaps, because a tool
you don't trust is a tool you don't reach for. Visibility comes next:
documents, logs and past runs without leaving the status page. After that,
speed and supervision — parallel steps, notifications, smarter retries and
whole backlogs.

## Ground rules for everything below

- **Zero install, no server.** One folder you copy into a project, nothing
  to install or keep running — works the same on Windows, macOS and Linux.
- **Watching never interferes.** The status page, history and logs are for
  your eyes only; nothing you open or look at can change what a run does.
- **Everything stays on disk.** Every step's output is a plain, readable
  document you can check, edit or reuse.

---

## Now — trust and visibility

### Settings that always take effect
*Today: the "which model" and "how hard should it try" options are
silently ignored — you can set them and nothing changes.*
Choose a stronger model for a step, or dial an agent's effort up or down,
and the run will genuinely use that choice. This item is a fix rather than
a feature: an option you write should never quietly do nothing.

### Mistakes caught before a run starts
*Today: a mistake in your pipeline setup — a step handing its work to a
step that doesn't exist, a misspelled AI name, a retry loop that can't
succeed — shows up halfway through a run, or not at all.*
Every run will check your setup first and explain any problem in plain
language before a single agent starts. A check that takes seconds protects
the hours a wasted run would cost.

### Every document, one click away
*Today: reading the plan, the review or the test report means hunting for
the right file in a folder.*
Each step on the status page will link to the document it produced, so you
read it right where you already are. Documents render simply — this is a
reading pane, not a document platform.

### A written record of every run
*Today: the run's messages live only in the terminal and scroll away.*
Every run will keep its own log — what started when, warnings, final
outcomes — as a readable file on disk. Combined with run history below, it
answers "what exactly happened overnight?" without replaying terminals.

### Every past run, side by side
*Today: each new run replaces the status page of the one before it, so
comparing runs is guesswork.*
The status page will keep a history of recent runs: pick any of them and
see it as it happened. "Which step failed last time?" and "how long did
coding take this week versus last?" become questions you answer by
looking.

### Recovery without detective work
*Today: after an interruption you must work out which step to resume from
and type the exact command yourself.*
Restart with `--from auto`: the kit works out where the last run stopped,
tells you what it chose and why, and continues from exactly there.

## Next — speed and supervision

### Independent steps run side by side
*Today: steps run strictly one after another, even when two of them depend
on nothing but the plan.*
Steps that don't depend on each other — detailed design and UI/UX design,
for example — will run at the same time. On typical pipelines this cuts a
fifth to a third off total run time, with the same results.

### A ping when a run ends
*Today: runs take hours, and you find out one failed the next morning.*
You'll give the kit one command of your own — a message to your team chat,
an email, whatever you already use — and it fires when a run finishes or
fails, carrying the outcome. The kit ships no integrations itself; you
plug in yours.

### A second opinion on retry
*Today: when a step keeps failing, every retry uses the same AI — the same
blind spots every time.*
You'll name a bench per step ("try this AI first, then that one"), and
each retry brings in the next one automatically. A stubborn step no longer
burns its whole retry budget on a bad match.

### Hand it a whole backlog
*Today: one feature per run; real development is a list.*
Give the kit a list of features and it works through them one by one,
unattended, each with its own run record and status page. You review the
results in the morning, in one place.

## Later — the longer arc

### One dashboard for everything
If you run the kit in several projects or branches, one page will list the
latest run in each and link to its full status page — a wallboard for the
team, still with no server to run.

### Know where the time goes
The status page will show time spent per step and per AI, and — where
Orca makes usage numbers available — what each consumed, with an export
for your spreadsheet. "Which AI is worth it for which step?" becomes a
question you answer with data instead of instinct.

### Edit the checklist from the page
The live task checklist is display-only today. Letting you edit it from
the page would mean relaxing our "no server, ever" rule, so this needs an
open design decision first. We may ship a lighter alternative — click a
task, get a ready-made edit to paste into the checklist — instead.

### No waiting between steps
*Today: every step spends its first stretch just getting its agent up and
running.*
The kit will keep an agent warm between consecutive steps that use the
same one, trimming that dead time from every run. Carefully: an agent that
is mid-job is never rushed or reused.

## What we deliberately won't build

- **A server or an installer.** We stay a single copy-paste folder that
  needs only Node. If the checklist editor above ever needs a local
  listener, it will be strictly opt-in and off by default.
- **Bundled integrations.** No built-in team chat, email or other hookup;
  you connect the tools you already use.
- **Approval gates on the checklist.** The task checklist stays a live
  view of what the coding agent is doing; the run will not stop and wait
  for you to tick boxes.
- **A "proper application."** No rewrite into a hosted service or a
  multi-part product. One folder you copy is the product.
