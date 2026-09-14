// Stateful fake of the Orca CLI for the E2E test suite (test/run-tests.mjs).
//
// Each orca() call in flow.mjs spawns a NEW process (node.exe via the
// NODE_OPTIONS preload), so state lives in a JSON file (ORCA_FAKE_STATE) and
// every invocation is appended to a JSONL call log (ORCA_FAKE_LOG) that the
// harness asserts against. A scenario module (ORCA_FAKE_SCENARIO) may run
// init(state) once (first invocation only) and override any default handler
// below — that is how timelines like "the Reviewer fails exactly once" or
// "the worker never settles" are scripted.
//
// Response contract mirrors what flow.mjs's orca() parses: a JSON object as
// the LAST stdout line, wrapped in {result: ...}; exit code 0 = ok.
const fs = require("node:fs");

function main(argv) {
  const env = process.env;
  if (!env.ORCA_FAKE_STATE || !env.ORCA_FAKE_LOG) {
    console.error("fake-orca: ORCA_FAKE_STATE / ORCA_FAKE_LOG not set");
    process.exit(2);
  }
  let state; let fresh = false;
  try { state = JSON.parse(fs.readFileSync(env.ORCA_FAKE_STATE, "utf8")); }
  catch {
    state = { nextId: 1, tasks: {}, dispatches: {}, terminals: {}, gates: [], pendingDone: [], extra: {} };
    fresh = true;
  }
  const scenario = env.ORCA_FAKE_SCENARIO ? require(env.ORCA_FAKE_SCENARIO) : { handlers: {} };
  if (fresh && scenario.init) scenario.init(state);

  const args = argv.filter((a) => a !== "--json");
  const flags = {}; const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--") && i + 1 < args.length && !String(args[i + 1]).startsWith("--"))
      flags[args[i].slice(2)] = args[++i];
    else if (args[i].startsWith("--")) flags[args[i].slice(2)] = true;
    else rest.push(args[i]);
  }
  const key = rest.slice(0, 2).join(" ");
  fs.appendFileSync(env.ORCA_FAKE_LOG, JSON.stringify({ t: Date.now(), cmd: key, flags }) + "\n");

  const save = (code, j) => {
    fs.writeFileSync(env.ORCA_FAKE_STATE, JSON.stringify(state));
    console.log(JSON.stringify(j));
    process.exit(code);
  };
  const c = {
    state, flags, rest, key,
    id: () => String(state.nextId++),
    pushDone: (task, outcome) => state.pendingDone.push({ task, outcome }),
    ok: (j) => save(0, { result: j ?? {} }),
    fail: (msg, code = 1) => save(code, { error: msg }),
  };
  const dispatchOfTask = (task) => Object.values(state.dispatches).find((d) => d.task === task);

  const DEFAULTS = {
    "status": () => c.ok({}),
    "worktree show": () => c.ok({ worktree: { path: env.ORCA_FAKE_WT || "." } }),
    "worktree list": () => c.ok({ worktrees: [] }),
    "worktree current": () => c.ok({ worktree: { path: env.ORCA_FAKE_WT || "." } }),

    "orchestration run-create": () => c.ok({ run: { id: "run-" + c.id() } }),
    "orchestration task-create": () => {
      const id = "task-" + c.id();
      state.tasks[id] = { id, run: flags.run, spec: String(flags.spec ?? ""), status: "ready", result: null };
      c.ok({ task: { id } });
    },
    "orchestration task-update": () => {
      const t = state.tasks[flags.id];
      if (t) { if (flags.status) t.status = flags.status; if (flags.result != null) t.result = flags.result; }
      c.ok({});
    },
    "orchestration task-list": () => c.ok({ tasks: Object.values(state.tasks)
      .filter((t) => t.run === flags.run)
      .map((t) => ({ id: t.id, status: t.status, result: t.result })) }),
    "orchestration dispatch": () => {
      if (flags["dry-run"] !== undefined)
        return c.ok({ preamble: "WORKER PREAMBLE dispatch=ctx_dryrun task=" + flags.task +
          "\n\n" + ((state.tasks[flags.task] || {}).spec || "") });
      const id = "disp-" + c.id();
      state.dispatches[id] = { id, task: flags.task, status: "dispatching", created: Date.now() };
      c.ok({ dispatch: { id } });
    },
    "orchestration dispatch-show": () => {
      const d = dispatchOfTask(flags.task);
      c.ok({ dispatch: { status: (d || {}).status || "dispatching", last_heartbeat_at: new Date().toISOString() } });
    },
    "orchestration worker-start": () => {
      const id = "disp-" + c.id();
      state.dispatches[id] = { id, task: flags.task, status: "dispatching", created: Date.now() };
      c.pushDone(flags.task, "succeeded");
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": () => {
      const d = state.dispatches[flags.dispatch] || {};
      c.ok({ terminal: { lastOutputAt: d.created || Date.now() } });
    },
    "orchestration worker-release": () => c.ok({}),
    "orchestration check": () => {
      if (flags.ack !== undefined) return c.ok({});
      const done = state.pendingDone.shift();
      if (!done) return c.ok({ messages: [] });
      c.ok({ deliveryId: "dlv-" + c.id(),
        messages: [{ type: "worker_done", taskId: done.task,
          payload: JSON.stringify(done.outcome == null ? {} : { outcome: done.outcome }) }] });
    },
    "orchestration gate-create": () => {
      const id = "gate-" + c.id();
      state.gates.push({ id, status: "pending", resolution: null });
      c.ok({ gate: { id } });
    },
    "orchestration gate-list": () => c.ok({ gates: state.gates }),
    "orchestration gate-resolve": () => c.ok({}),

    "terminal create": () => c.fail("terminal create unavailable (default forces the cold-start path)"),
    "terminal show": () => c.ok({ terminal: ((state.terminals[flags.terminal] || {}).info) || {} }),
    "terminal send": () => c.ok({}),
    "terminal close": () => c.ok({}),
  };

  const h = (scenario.handlers || {})[key] || DEFAULTS[key];
  if (!h) { console.error('fake-orca: no handler for "' + key + '"'); process.exit(2); }
  h(c);
}

module.exports = { main };
