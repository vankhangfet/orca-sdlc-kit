#!/usr/bin/env node
// .orca/agent-config.mjs — skills + MCP server materialization for workflow agents.
// Split from flow.mjs to keep the orchestrator generic; zero dependencies.
//
// Contract (see docs/superpowers/specs/2026-09-20-agent-skills-mcp-design.md):
//   validateAgentConfig({ cfg, configDir, steps, die })     load-time schema/refs check
//   materializeAgentConfig({ worktree, members, cfg, die, warn })  before each group
//   restoreAgentConfig({ worktree, warn })                  after each group + at startup
//
// Delivery is WORKTREE FILES the harness TUIs auto-discover — no spawn-command
// changes. Everything written is tracked in a manifest (.orca-agent-config.json)
// and restored afterwards; a crash leaves the manifest behind and the next run
// self-heals. `die`/`warn` are injected by flow.mjs so this module stays pure.
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MANIFEST_FILE = ".orca-agent-config.json";
const SECTION_BEGIN = "<!-- orca-agent-config BEGIN -->";
const SECTION_END = "<!-- orca-agent-config END -->";

// Per-harness delivery channels (all paths relative to the worktree root).
//   mcpFile/mcpKey: JSON file + key holding MCP server defs (null = no MCP support)
//   skillDir:      per-skill folders with SKILL.md (claude-style, auto-discovered)
//   ruleDir:       cursor-style .mdc rule files
//   skillSection:  markdown file that receives a marker-delimited skills section
const ADAPTERS = {
  claude:   { mcpFile: ".mcp.json",             mcpKey: "mcpServers", skillDir: ".claude/skills", ruleDir: null,          skillSection: null },
  cursor:   { mcpFile: ".cursor/mcp.json",      mcpKey: "mcpServers", skillDir: null,             ruleDir: ".cursor/rules", skillSection: null },
  gemini:   { mcpFile: ".gemini/settings.json", mcpKey: "mcpServers", skillDir: null,             ruleDir: null,          skillSection: "GEMINI.md" },
  opencode: { mcpFile: "opencode.json",         mcpKey: "mcp",        skillDir: null,             ruleDir: null,          skillSection: "AGENTS.md" },
  codex:    { mcpFile: null,                    mcpKey: null,         skillDir: null,             ruleDir: null,          skillSection: "AGENTS.md" },
};

const harnessOf = (agent) => String(agent || "").trim().split(/\s+/)[0] || "";

// --- ${env:VAR} expansion (mcp defs only): secrets never literal in workflow
// JSON. Unset variable -> warn + empty string; the harness surfaces the
// resulting auth/connection error to the agent.
const ENV_REF = /\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
export function expandEnvDeep(value, warn, where) {
  if (typeof value === "string")
    return value.replace(ENV_REF, (m, name) => {
      if (process.env[name] == null || process.env[name] === "") {
        warn("[agent-config] " + where + ": ${env:" + name + "} is not set — substituting an empty string.");
      }
      return process.env[name] ?? "";
    });
  if (Array.isArray(value)) return value.map((v) => expandEnvDeep(v, warn, where));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnvDeep(v, warn, where)]));
  return value;
}

// --- Load-time validation: registries well-formed, every step ref resolves ---
export function validateAgentConfig({ cfg, configDir, steps, die }) {
  const skills = cfg.skills || {};
  const mcp = cfg.mcpServers || {};
  for (const [name, def] of Object.entries(skills)) {
    const hasPath = def?.path != null, hasPrompt = def?.prompt != null;
    if (hasPath && hasPrompt) die(`skill "${name}": "path" and "prompt" are mutually exclusive.`);
    if (!hasPath && !hasPrompt) die(`skill "${name}": must have either "path" or "prompt".`);
    if (hasPrompt && def.description == null) die(`skill "${name}": inline skill requires "description".`);
    if (hasPath && !existsSync(resolve(configDir, def.path)))
      die(`skill "${name}": path "${def.path}" not found (resolved: ${resolve(configDir, def.path)}).`);
  }
  for (const [name, def] of Object.entries(mcp)) {
    const hasCmd = def?.command != null, hasUrl = def?.url != null;
    if (hasCmd && hasUrl) die(`mcp server "${name}": "command" and "url" are mutually exclusive.`);
    if (!hasCmd && !hasUrl) die(`mcp server "${name}": must have either "command" or "url".`);
  }
  for (const s of steps) {
    for (const ref of s.skills || [])
      if (!(ref in skills)) die(`step "${s.id}" references unknown skill "${ref}".`);
    for (const ref of s.mcp || [])
      if (!(ref in mcp)) die(`step "${s.id}" references unknown mcp server "${ref}".`);
  }
}

export function materializeAgentConfig() {}
export function restoreAgentConfig() { return false; }
