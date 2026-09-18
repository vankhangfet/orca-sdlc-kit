// E24 nudge-undeliverable: a mid-run nudge is attempted but the terminal
// send FAILS (transient CLI error) — the budget is closed without a single
// delivered nudge. When worker_done(succeeded) then arrives with the
// artifact still missing, the step must settle with the ORIGINAL outcome
// (not failed) and the "(nudge undeliverable)" note.
//
// The default "orchestration check" handler is used deliberately: the done
// sits in pendingDone ONLY after the failed send pushes it, so the wait
// loop sees no done until then — and delivers it on the very next slice.
module.exports = {
  handlers: {
    "orchestration dispatch-show": (c) =>
      c.ok({ dispatch: { status: "dispatching", last_heartbeat_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() } }),
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.state.nudgeTask = c.flags.task;
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-undeliv", lastOutputAt: Date.now() - 30 * 60 * 1000, preview: "frozen screen" } }),
    "terminal send": (c) => {
      c.pushDone(c.state.nudgeTask, "succeeded");   // the agent finishes on its own around the failed nudge
      c.fail("simulated transient send failure");
    },
  },
};
