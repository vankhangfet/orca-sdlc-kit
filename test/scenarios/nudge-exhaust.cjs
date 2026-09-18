// E20 nudge-exhaust: same setup as nudge-recover, but the terminal NEVER
// complies — the sends land and nothing happens. The flow must spend exactly
// nudgeRetries text nudges, then settle the step failed with the
// "artifact missing after N nudge(s)" note.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.pushDone(c.flags.task, "succeeded");          // done, but NO materialize
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-nudge", lastOutputAt: Date.now(), preview: "agent idle at prompt" } }),
    // The nudge must be DELIVERED and ignored: a handler that returns without
    // ok/fail exits the fake with code 3, which flow.mjs reads as a FAILED
    // send (the E24 undeliverable path) — here the sends must land and do
    // nothing. c.ok({}) is the swallow.
    "terminal send": (c) => c.ok({}),
  },
};
