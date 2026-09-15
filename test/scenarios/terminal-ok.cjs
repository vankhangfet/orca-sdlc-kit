// E2 happy-manual: terminals CAN be created. lastOutputAt is fixed (rendered
// once, then quiet) so the warm-up quiet-detect passes; every send FLIPS the
// preview — proving consumption exactly like a real TUI rendering the paste.
// The created command is recorded for the AUTO-RUN claude-wrap assertion.
module.exports = {
  handlers: {
    "terminal create": (c) => {
      const h = "term-" + c.id();
      c.state.terminals[h] = { info: { lastOutputAt: Date.now() - 15000, preview: "claude welcome screen" }, command: c.flags.command, sends: [] };
      c.ok({ handle: h });
    },
    "terminal send": (c) => {
      const t = c.state.terminals[c.flags.terminal];
      if (t) { t.sends.push(String(c.flags.text ?? "")); t.info.preview = "working on pasted prompt [" + t.sends.length + "]"; }
      c.ok({});
    },
    // The manual path dispatches to a terminal, so worker-start (whose default
    // handler is what queues worker_done) never runs — with pure defaults the
    // step would sit until the hard cap. A real Orca delivers worker_done
    // because the dispatched worker actually RUNS the pasted preamble; emulate
    // exactly that: once a preamble naming a task has been pasted, that worker
    // reports done — once (a real worker finishes one time).
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      if (c.state.extra.workerDone) return c.ok({ messages: [] });
      const sent = [].concat(...Object.values(c.state.terminals).map((t) => t.sends));
      const task = (sent.join("\n").match(/task=(task-\d+)/) || [])[1];
      if (!task) return c.ok({ messages: [] });
      c.state.extra.workerDone = true;
      c.ok({ deliveryId: "dlv-" + c.id(),
        messages: [{ type: "worker_done", taskId: task, payload: JSON.stringify({ outcome: "succeeded" }) }] });
    },
  },
};
