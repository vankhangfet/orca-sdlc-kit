// E8 retry-exhaust: the Reviewer always fails; with maxRetries:1 the loop
// must give up after the bounded number of jumps — never spin forever.
module.exports = {
  init: (s) => { s.extra.reviewerFails = 99; },
  handlers: {
    "orchestration worker-start": (c) => {
      const t = c.state.tasks[c.flags.task] || {};
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      let outcome = "succeeded";
      if (/Reviewer/.test(t.spec)) outcome = "failed";
      c.pushDone(c.flags.task, outcome);
      c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
