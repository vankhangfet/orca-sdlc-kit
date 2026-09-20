#!/usr/bin/env node
// Workflow Designer — opt-in local UI for building *.config.json pipelines.
// Zero dependencies (Node builtins). flow.mjs is untouched: the designer only
// reads/writes config files and spawns `flow.mjs --dry-run` for validation.
// Spec: docs/superpowers/specs/2026-09-20-workflow-designer-design.md
//
// Usage:
//   node .orca/designer.mjs [--port <n>] [--no-open]
//     --port     default 7887, falls back 7888..7896; 0 = ephemeral (tests)
//     --no-open  do not auto-open the browser
//
// Security: binds 127.0.0.1 only; every request must carry the per-launch
// token (query ?t= or x-designer-token header) and a localhost Host header.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, mkdirSync, cpSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // .orca/
const ROOT = dirname(HERE);                           // project root
const FLOW = join(HERE, "flow.mjs");
const TEMPLATES_DIR = join(HERE, "workflow-template");
const IS_WIN = process.platform === "win32";
const TOKEN = randomBytes(16).toString("hex");

// --- argv ---
const argv = process.argv.slice(2);
let portArg = 7887;
let autoOpen = true;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") portArg = Number(argv[++i]);
  else if (argv[i] === "--no-open") autoOpen = false;
}
const log = (...a) => console.log("[designer]", ...a);
const die = (m) => { console.error("[designer] ERROR:", m); process.exit(1); };
if (!Number.isInteger(portArg) || portArg < 0 || portArg > 65535) die("--port must be an integer 0..65535");

// --- shared helpers ---
// Client-supplied config paths may only address files INSIDE .orca/. Returns
// the resolved absolute path, or null when the path escapes / is invalid.
function safePath(rel) {
  if (typeof rel !== "string" || rel.includes("\0")) return null;
  const full = resolve(HERE, rel);
  if (full !== HERE && !full.startsWith(HERE + sep)) return null;
  return full;
}
function sendJson(res, status, obj) {
  const t = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(t) });
  res.end(t);
}
function readBody(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { r({ ok: true, body: b ? JSON.parse(b) : {} }); } catch (e) { r({ ok: false, error: `invalid JSON body: ${e.message}` }); } });
    req.on("error", () => r({ ok: false, error: "request read error" }));
  });
}
// Crash-safe config write: a half-written file can never replace the original.
function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
function listConfigs() {
  const out = [];
  const scan = (dir, template) => {
    try {
      for (const f of readdirSync(dir))
        if (f.endsWith(".config.json"))
          out.push({ path: (template ? "workflow-template/" : "") + f, name: f.replace(/\.config\.json$/, ""), template });
    } catch {}
  };
  scan(HERE, false);
  scan(TEMPLATES_DIR, true);
  return out;
}

// --- API handlers (one per feature task) ---
async function apiState() {
  return { status: 200, configs: listConfigs() };
}

function apiConfig(q) {
  const rel = q.get("path");
  if (!rel || !rel.endsWith(".config.json")) return { status: 400, error: "path must be a *.config.json inside .orca/" };
  const full = safePath(rel);
  if (!full) return { status: 400, error: "path escapes .orca/ — refused" };
  if (!existsSync(full)) return { status: 404, error: `config not found: ${rel}` };
  try { return { status: 200, config: JSON.parse(readFileSync(full, "utf8")) }; }
  catch (e) { return { status: 400, error: `could not parse ${rel}: ${e.message}` }; }
}

function apiSave(body) {
  if (!body || typeof body !== "object" || typeof body.path !== "string" ||
      typeof body.config !== "object" || body.config === null || Array.isArray(body.config))
    return { status: 400, error: "body must be { path, config } with config an object" };
  if (!body.path.endsWith(".config.json")) return { status: 400, error: "path must end in .config.json" };
  const full = safePath(body.path);
  if (!full) return { status: 400, error: "path escapes .orca/ — refused" };
  if (!Array.isArray(body.config.pipeline)) return { status: 400, error: "config.pipeline must be an array" };
  let text;
  try { text = JSON.stringify(body.config, null, 2) + "\n"; }
  catch (e) { return { status: 400, error: `config is not serializable: ${e.message}` }; }
  // Preservation contract: write EXACTLY the posted object. The UI edits the
  // parsed raw object in place, so "//" comment keys and unknown fields ride
  // along untouched. Never rebuild the object here.
  try { atomicWrite(full, text); }
  catch (e) { return { status: 500, error: `could not write ${body.path}: ${e.message}` }; }
  return { status: 200, saved: body.path.split("\\").join("/") };
}

function apiDryRun(body) {
  return new Promise((done) => {
    if (!body || typeof body.path !== "string") return done({ status: 400, error: "body must be { path }" });
    const rel = body.path.split("\\").join("/");
    if (!rel.endsWith(".config.json")) return done({ status: 400, error: "path must be a *.config.json inside .orca/" });
    const full = safePath(rel);
    if (!full || !existsSync(full)) return done({ status: 404, error: `config not found: ${rel}` });
    // Dry-run never calls agents (flow.mjs prints the plan and exits), so the
    // 15s cap only guards against a pathological hang. cwd = project root so
    // worktree auto-detection behaves like a user-run command.
    const child = spawn(process.execPath,
      [FLOW, "designer validation", "--config", rel, "--dry-run", "--no-open-status"],
      { cwd: ROOT });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => { clearTimeout(timer); done({ status: 500, error: `could not spawn flow.mjs: ${e.message}` }); });
    child.on("close", (code) => { clearTimeout(timer); done({ status: 200, code, timedOut, output: out }); });
  });
}

function dirState(dirRaw) {
  const dir = resolve(ROOT, dirRaw);
  let exists = false, empty = false, hasOrca = false;
  try {
    exists = existsSync(dir);
    if (exists) {
      empty = readdirSync(dir).length === 0;
      hasOrca = existsSync(join(dir, ".orca"));
    }
  } catch {}
  return { dir, exists, empty, hasOrca };
}
function apiScaffoldPreview(q) {
  const dirRaw = q.get("dir");
  if (!dirRaw) return { status: 400, error: "dir query param required" };
  return { status: 200, ...dirState(dirRaw) };
}
function apiScaffold(body) {
  if (!body || typeof body.dir !== "string" || typeof body.template !== "string" || typeof body.configName !== "string")
    return { status: 400, error: "body must be { dir, template, configName }" };
  const name = body.configName.replace(/\.config\.json$/, "");
  if (!/^[\w.-]+$/.test(name)) return { status: 400, error: "configName may only contain letters, digits, '.', '_', '-'" };
  const tplFull = safePath(body.template);
  if (!tplFull || !body.template.endsWith(".config.json") || !existsSync(tplFull))
    return { status: 400, error: `unknown template: ${body.template}` };
  const st = dirState(body.dir);
  if (st.dir === ROOT || st.dir === HERE || (st.dir + sep).startsWith(HERE + sep))
    return { status: 400, error: "refusing to scaffold inside the kit's own folder" };
  if (st.hasOrca) return { status: 400, error: `${st.dir} already contains .orca/ — refusing to overwrite` };
  try {
    mkdirSync(st.dir, { recursive: true });
    // Copy the whole kit (.orca/), minus runtime/junk output. orca.yaml rides along.
    cpSync(HERE, join(st.dir, ".orca"), {
      recursive: true,
      filter: (src) => {
        const rel = src.slice(HERE.length).split(sep).join("/");
        if (rel === "") return true;
        if (/^\/(artifacts|status-preview|usage-test)(\/|$)/.test(rel)) return false;
        return !/\.(log|tmp)$/.test(rel);
      },
    });
    const orcaYaml = join(ROOT, "orca.yaml");
    if (existsSync(orcaYaml)) writeFileSync(join(st.dir, "orca.yaml"), readFileSync(orcaYaml));
    // First config: the chosen template, under the project's own name.
    atomicWrite(join(st.dir, ".orca", `${name}.config.json`), readFileSync(tplFull, "utf8"));
    // .gitignore: extend an existing one exactly once (mirror init.mjs).
    const gi = join(st.dir, ".gitignore");
    if (existsSync(gi)) {
      const t = readFileSync(gi, "utf8");
      if (!t.split(/\r?\n/).includes(".orca/artifacts/"))
        writeFileSync(gi, t.replace(/\r?\n?$/, "\n") + ".orca/artifacts/\n");
    }
  } catch (e) { return { status: 500, error: `scaffold failed: ${e.message}` }; }
  return { status: 200, dir: st.dir, config: `${name}.config.json`,
    command: `node .orca/flow.mjs "<objective>" --config ${name}.config.json` };
}

// --- page ---
const PAGE = (() => {
  try { return readFileSync(join(HERE, "designer.html"), "utf8"); }
  catch { return "<!doctype html><meta charset='utf-8'><title>Orca Workflow Designer</title><p>designer.html is missing next to designer.mjs</p>"; }
})();

// --- server ---
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const host = String(req.headers.host || "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") return sendJson(res, 403, { error: "host not allowed" });
  const tok = u.searchParams.get("t") || req.headers["x-designer-token"];
  if (tok !== TOKEN) return sendJson(res, 403, { error: "bad or missing token" });

  if (req.method === "GET" && (u.pathname === "/" || u.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (!u.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "not found" });

  let r;
  if (req.method === "GET" && u.pathname === "/api/state") r = await apiState();
  else if (req.method === "GET" && u.pathname === "/api/config") r = apiConfig(u.searchParams);
  else if (req.method === "POST" && u.pathname === "/api/save") {
    const b = await readBody(req);
    r = b.ok ? apiSave(b.body) : { status: 400, error: b.error };
  }
  else if (req.method === "POST" && u.pathname === "/api/dry-run") {
    const b = await readBody(req);
    r = b.ok ? await apiDryRun(b.body) : { status: 400, error: b.error };
  }
  else if (req.method === "GET" && u.pathname === "/api/scaffold/preview") r = apiScaffoldPreview(u.searchParams);
  else if (req.method === "POST" && u.pathname === "/api/scaffold") {
    const b = await readBody(req);
    r = b.ok ? apiScaffold(b.body) : { status: 400, error: b.error };
  }
  else return sendJson(res, 404, { error: `no route: ${req.method} ${u.pathname}` });
  sendJson(res, r.status, r);
});

function listenOnce(port) {
  return new Promise((r) => {
    const onErr = () => { server.removeListener("error", onErr); r(false); };
    server.once("error", onErr);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", onErr); r(true); });
  });
}
async function start() {
  if (portArg === 0) {
    if (!(await listenOnce(0))) die("could not bind an ephemeral port");
    return;
  }
  for (let p = portArg; p < portArg + 10; p++) if (await listenOnce(p)) return;
  die(`no free port in ${portArg}..${portArg + 9} — pass --port <n>`);
}
process.on("uncaughtException", (e) => log("uncaught:", e.message));

await start();
const URL_ = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
log(`listening ${URL_}`);
if (autoOpen) {
  // explorer.exe always exits non-zero — same noise-tolerance as flow.mjs.
  const r = IS_WIN ? spawnSync("explorer.exe", [URL_], { timeout: 10000, stdio: "ignore" })
    : process.platform === "darwin" ? spawnSync("open", [URL_], { timeout: 10000, stdio: "ignore" })
    : spawnSync("xdg-open", [URL_], { timeout: 10000, stdio: "ignore" });
  if (r.error) log(`could not auto-open the browser (${r.error.message}) — open it yourself: ${URL_}`);
}
log("Ctrl+C stops the designer.");
