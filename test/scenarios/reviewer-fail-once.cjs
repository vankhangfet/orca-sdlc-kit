// E7 fail-retry: the Reviewer's FIRST completion reports outcome=failed; the
// fix loop jumps back to the Coder (onFailGoto), reopens its task, and the
// second pass succeeds. Guards regression #2 (cached task must be reopened,
// not re-created — no double dispatch).
module.exports = {
  init: (s) => { s.extra.reviewerFails = 1; },
  handlers: {
    "orchestration worker-start": (c) => {
      const t = c.state.tasks[c.flags.task] || {};
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      let outcome = "succeeded";
      if (/Reviewer/.test(t.spec) && c.state.extra.reviewerFails > 0) { c.state.extra.reviewerFails--; outcome = "failed"; }
      c.materialize(t, outcome);
      c.pushDone(c.flags.task, outcome);
      c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
