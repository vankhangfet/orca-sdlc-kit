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
