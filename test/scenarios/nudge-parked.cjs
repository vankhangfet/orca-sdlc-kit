// E22 nudge-parked: every nudge precondition holds (frozen preview, stale
// heartbeat, missing artifact, no worker_done) EXCEPT the worker is parked
// on a permission dialog — the flow must send NOTHING (typing into a dialog
// only a human may answer is the one forbidden move) and hold to the hard
// cap per #4 semantics.
module.exports = {
  handlers: {
    // stylistic override — nothing here ever pushes a done (the default check
    // handler returns empty anyway); do not assume it is load-bearing.
    "orchestration check": (c) => c.ok({ messages: [] }),
    "orchestration dispatch-show": (c) =>
      c.ok({ dispatch: { status: "dispatching", last_heartbeat_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() } }),
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-parked", lastOutputAt: Date.now() - 30 * 60 * 1000,
        preview: "claude code\r\nBash command requires confirmation for this command. Do you want to proceed? (y/n)" } }),
  },
};
