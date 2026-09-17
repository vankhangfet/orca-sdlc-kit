// E14 readiness-exhaust: the worker reports succeeded but never materializes
// its artifact — the "lying success". The readiness gate must count attempts
// and stop after readinessRetries instead of looping forever.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.pushDone(c.flags.task, "succeeded");   // done — but NO artifact write
      c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
