// N5 mixed group: Right FAILS while Left never settles (hard-caps as
// still-running). The main loop dies on the LIVE member — the chat hint must
// point PAST the group (join), never at the failed sibling whose re-run would
// re-dispatch the live worker.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const t = c.state.tasks[c.flags.task] || {};
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      if (/Right/.test(t.spec)) c.pushDone(c.flags.task, "failed");   // Left: nothing — hard cap settles it
      c.ok({ dispatchId: id, state: "ready" });
    },
  },
};
