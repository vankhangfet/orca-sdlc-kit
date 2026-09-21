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
    if (hasPath && (typeof def.path !== "string" || def.path === ""))
      die(`skill "${name}": "path" must be a non-empty string.`);
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

// --- Manifest plan: everything we touch, so restore can put it back.
// Files are snapshotted as text; skill FOLDERS are never overwritten (a
// pre-existing folder of the same name is kept with a warn — user-owned).
function newPlan(worktree, warn) {
  const created = [];
  const modified = [];
  const rememberFile = (rel) => {
    const abs = join(worktree, rel);
    if (existsSync(abs)) {
      if (!modified.some((m) => m.path === rel))
        modified.push({ path: rel, original: readFileSync(abs, "utf8") });
      return modified.find((m) => m.path === rel).original;
    }
    // Not there (yet): record original=null so restore REMOVES the file we are
    // about to create (the mod.original == null branch in restoreAgentConfig).
    if (!modified.some((m) => m.path === rel))
      modified.push({ path: rel, original: null });
    return null;
  };
  return {
    created, modified,
    // Write a TEXT file at rel (snapshotting the original first).
    write: (rel, text) => {
      rememberFile(rel);
      mkdirSync(dirname(join(worktree, rel)), { recursive: true });
      writeFileSync(join(worktree, rel), text);
    },
    // Track a DIRECTORY we are about to create wholesale, plus every ancestor
    // that does not exist YET (checked before the mkdir): restore removes the
    // whole chain; pre-existing user-owned ancestors are never touched.
    trackDir: (rel) => {
      for (let cur = rel; cur && cur !== "." && !existsSync(join(worktree, cur)); cur = dirname(cur))
        if (!created.includes(cur)) created.push(cur);
    },
    rememberFile,
  };
}

// --- Skill body resolution -------------------------------------------------
// Inline: generated SKILL.md. Path: dir copied verbatim (skillDir adapters) or
// its SKILL.md/file text inlined (section/rule adapters).
function inlineSkillMd(name, def) {
  return `---\nname: ${name}\ndescription: ${def.description}\n---\n\n${def.prompt}\n`;
}
function pathSkillText(def, configDir, die) {
  const src = resolve(configDir, def.path);
  const file = statSync(src).isFile() ? src : join(src, "SKILL.md");
  try { return readFileSync(file, "utf8"); } catch (e) { die(`skill source unreadable (${file}): ${e.message}`); }
}

// --- Materialize: union of the group's refs per harness -> worktree files ---
export function materializeAgentConfig({ worktree, members, cfg, configDir, die, warn }) {
  // Self-heal first: a manifest left by a crashed previous group must never be
  // overwritten (its created/modified entries would be lost).
  if (existsSync(join(worktree, MANIFEST_FILE))) {
    warn("[agent-config] found a leftover manifest — restoring before materializing.");
    restoreAgentConfig({ worktree, warn });
  }

  const skills = cfg.skills || {};
  const mcp = cfg.mcpServers || {};
  const mcpRefs = new Map();     // harness -> Set(serverName)
  const skillRefs = new Map();   // harness -> Set(skillName)
  const owners = new Map();      // harness -> Set(stepId)   (for the union log)
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, new Set()); map.get(k).add(v); };
  let any = false;

  for (const s of members) {
    if (!(s.skills || []).length && !(s.mcp || []).length) continue;
    any = true;
    const h = harnessOf(s.agent);
    const a = ADAPTERS[h];
    if (!a) {
      warn(`[agent-config] step "${s.id}": agent "${h}" has no skills/MCP adapter — skipping ` +
        `skills=[${(s.skills || []).join(",") || "-"}] mcp=[${(s.mcp || []).join(",") || "-"}].`);
      continue;
    }
    for (const r of s.mcp || []) {
      if (!a.mcpFile) {
        warn(`[agent-config] step "${s.id}": agent "${h}" does not support MCP servers via worktree — skipping mcp "${r}".`);
        continue;
      }
      add(mcpRefs, h, r); add(owners, h, s.id);
    }
    for (const r of s.skills || []) { add(skillRefs, h, r); add(owners, h, s.id); }
  }
  if (!any) return;

  // Union across parallel members sharing the worktree: one log line when it happens.
  for (const [h, ids] of owners)
    if (ids.size > 1) warn(`[agent-config] ${h}: merged skills/MCP refs from ${ids.size} parallel steps (${[...ids].join(", ")}).`);

  const plan = newPlan(worktree, warn);

  // MCP JSON files, one per harness that has refs.
  for (const [h, names] of mcpRefs) {
    const a = ADAPTERS[h];
    const orig = plan.rememberFile(a.mcpFile);
    let doc = {};
    if (orig != null) {
      try { doc = JSON.parse(orig); } catch (e) { die(`${a.mcpFile} already exists in the worktree and is not valid JSON: ${e.message}`); }
    }
    doc[a.mcpKey] = { ...(doc[a.mcpKey] || {}) };
    for (const name of names)
      doc[a.mcpKey][name] = expandEnvDeep(mcp[name], warn, `mcp server "${name}"`);
    plan.write(a.mcpFile, JSON.stringify(doc, null, 2) + "\n");
    warn(`[agent-config] ${h}: ${names.size} mcp server(s) -> ${a.mcpFile}`);
  }

  // Section-channel skills, merged PER FILE (codex + opencode share AGENTS.md).
  const sectionSkills = new Map();   // file -> Map(name -> def)
  for (const [h, names] of skillRefs) {
    const a = ADAPTERS[h];
    let wrote = 0;
    for (const name of names) {
      const def = skills[name];
      if (a.skillDir) {
        const rel = `${a.skillDir}/${name}`;
        if (existsSync(join(worktree, rel))) {
          warn(`[agent-config] ${rel} already exists in the worktree — keeping yours, skipping skill "${name}".`);
          continue;
        }
        plan.trackDir(rel);
        mkdirSync(join(worktree, rel), { recursive: true });
        if (def.path != null) {
          cpSync(resolve(configDir, def.path), join(worktree, rel), { recursive: true });
        } else {
          writeFileSync(join(worktree, rel, "SKILL.md"), inlineSkillMd(name, def));
        }
        wrote++;
      } else if (a.ruleDir) {
        const body = def.path != null ? pathSkillText(def, configDir, die) : def.prompt;
        const desc = def.path != null ? name : def.description;
        plan.write(`${a.ruleDir}/${name}.mdc`, `---\ndescription: ${desc}\n---\n\n${body}\n`);
        wrote++;
      } else if (a.skillSection) {
        if (!sectionSkills.has(a.skillSection)) sectionSkills.set(a.skillSection, new Map());
        sectionSkills.get(a.skillSection).set(name, def);
        wrote++;
      }
    }
    if (wrote) warn(`[agent-config] ${h}: ${wrote} skill(s) -> ${a.skillDir || a.ruleDir || a.skillSection}`);
  }
  for (const [file, defs] of sectionSkills) {
    const orig = plan.rememberFile(file);
    const prev = orig == null ? "" : orig;
    // Idempotent: strip any previous managed section before appending.
    const stripped = prev.replace(sectionRx(), "").replace(/\n*$/, "\n");
    const items = [...defs.entries()].map(([name, def]) =>
      `### ${name}\n\n${def.path != null ? pathSkillText(def, configDir, die) : def.prompt}\n`).join("\n");
    plan.write(file, `${stripped}\n${SECTION_BEGIN}\n\n## Skills (managed by orca-flow)\n\n${items}\n${SECTION_END}\n`);
  }

  writeFileSync(join(worktree, MANIFEST_FILE),
    JSON.stringify({ created: plan.created, modified: plan.modified }, null, 2) + "\n");
}

function sectionRx() {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\n?${esc(SECTION_BEGIN)}[\\s\\S]*?${esc(SECTION_END)}\\n?`);
}

// --- Restore: created -> delete, modified -> original back, manifest -> gone.
// Best-effort per entry (AV file locks on Windows): on partial failure the
// manifest is KEPT so the next run's self-heal can retry.
export function restoreAgentConfig({ worktree, warn }) {
  const mp = join(worktree, MANIFEST_FILE);
  if (!existsSync(mp)) return false;
  let m;
  try { m = JSON.parse(readFileSync(mp, "utf8")); } catch (e) {
    warn(`[agent-config] manifest unreadable (${e.message}) — leaving worktree files alone.`);
    return false;
  }
  let failed = false;
  for (const rel of m.created || []) {
    try { rmSync(join(worktree, rel), { recursive: true, force: true }); }
    catch (e) { failed = true; warn(`[agent-config] could not remove ${rel}: ${e.message}`); }
  }
  for (const mod of m.modified || []) {
    try {
      if (mod.original == null) rmSync(join(worktree, mod.path), { recursive: true, force: true });
      else { mkdirSync(dirname(join(worktree, mod.path)), { recursive: true }); writeFileSync(join(worktree, mod.path), mod.original); }
    } catch (e) { failed = true; warn(`[agent-config] could not restore ${mod.path}: ${e.message}`); }
  }
  if (failed) { warn("[agent-config] restore incomplete — manifest kept for the next run's self-heal."); return true; }
  try { rmSync(mp, { force: true }); } catch (e) { warn(`[agent-config] could not remove manifest: ${e.message}`); }
  return true;
}
