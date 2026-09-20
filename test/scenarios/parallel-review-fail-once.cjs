// E27 parallel review fail-retry: inside the [code-review ∥ security-review]
// group, Security Review FAILS its first completion (Code Review passes).
// The onFailGoto loop reopens the Coder, and the retry re-runs the WHOLE
// group — a second dispatch for BOTH review members, not just the failed one.
module.exports = {
  init: (s) => { s.extra.securityFails = 1; },
  handlers: {
    "orchestration worker-start": (c) => {
      const t = c.state.tasks[c.flags.task] || {};
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      let outcome = "succeeded";
      if (/Security Review/.test(t.spec) && c.state.extra.securityFails > 0) { c.state.extra.securityFails--; outcome = "failed"; }
      c.materialize(t, outcome);
      c.pushDone(c.flags.task, outcome);
      c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
