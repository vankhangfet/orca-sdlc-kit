// Snapshot the worktree's agent-config surface into state.extra at every
// task-create (materialize has run by then; restore has not). The test reads
// state.json afterwards. Only overrides task-create; all other commands use
// the fake's DEFAULTS.
const fs = require("node:fs");
const { join } = require("node:path");

const FILES = [".mcp.json", ".cursor/mcp.json", ".gemini/settings.json", "opencode.json",
  "AGENTS.md", "GEMINI.md", ".orca-agent-config.json"];

module.exports = {
  handlers: {
    "orchestration task-create": (c) => {
      const wt = process.env.ORCA_FAKE_WT || ".";
      const snap = {};
      for (const f of FILES) {
        try { snap[f] = fs.readFileSync(join(wt, f), "utf8"); } catch { snap[f] = null; }
      }
      for (const d of [".claude/skills", ".cursor/rules"]) {
        try { snap[d] = fs.readdirSync(join(wt, ...d.split("/"))); } catch { snap[d] = null; }
      }
      try { snap[".claude/skills/review-checklist/SKILL.md"] =
        fs.readFileSync(join(wt, ".claude", "skills", "review-checklist", "SKILL.md"), "utf8"); } catch {}
      try { snap[".cursor/rules/commit-style.mdc"] =
        fs.readFileSync(join(wt, ".cursor", "rules", "commit-style.mdc"), "utf8"); } catch {}
      c.state.extra.cfgSnap ||= {};
      c.state.extra.cfgSnap[(String(c.flags.spec ?? "").match(/^# (.+)$/m) || [])[1] ?? String(c.flags.run)] = snap;
      const id = "task-" + c.id();
      c.state.tasks[id] = { id, run: c.flags.run, spec: String(c.flags.spec ?? ""), status: "ready", result: null };
      c.ok({ task: { id } });
    },
  },
};
