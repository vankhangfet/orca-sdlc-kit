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
    // Deterministic send ladder: preamble + bare-Enter + the guaranteed nudge rung (the fake's synchronous preview flip makes attempt 1 see no change) — expect 3 sends, 2 of them empty.
    "terminal send": (c) => {
      const t = c.state.terminals[c.flags.terminal];
      if (!t) return c.fail("unknown terminal " + c.flags.terminal);
      t.sends.push(String(c.flags.text ?? ""));
      t.info.preview = "working on pasted prompt [" + t.sends.length + "]";
      c.ok({});
    },
    // The manual path dispatches to a terminal, so worker-start (whose default
    // handler is what queues worker_done) never runs — with pure defaults the
    // step would sit until the hard cap. A real Orca delivers worker_done
    // because the dispatched worker actually RUNS the pasted preamble; emulate
    // exactly that: once a preamble naming a task has been pasted, that worker
    // reports done — once per task id, so the emulation is multi-step safe
    // (a real worker finishes once per delivered task).
    "orchestration check": (c) => {
      if (c.flags.ack !== undefined) return c.ok({});
      const sent = [].concat(...Object.values(c.state.terminals).map((t) => t.sends));
      // Newest pasted task = the live worker; older steps' tasks are already
      // in doneFor and must not shadow the current one.
      const pasted = sent.join("\n").match(/task=(task-\d+)/g) || [];
      const task = pasted.length ? pasted[pasted.length - 1].slice("task=".length) : null;
      if (task) {
        c.state.extra.doneFor ||= {};
        if (c.state.extra.doneFor[task]) return c.ok({ messages: [] });
        c.state.extra.doneFor[task] = true;
        return c.ok({ deliveryId: "dlv-" + c.id(),
          messages: [{ type: "worker_done", taskId: task, payload: JSON.stringify({ outcome: "succeeded" }) }] });
      }
      // No task= pasted (manual path never reached the paste — e.g. a degraded run fell back to cold-start): drain the default pendingDone queue so fallback failures stay crisp instead of hard-capping.
      const done = c.state.pendingDone.shift();
      if (!done) return c.ok({ messages: [] });
      c.ok({ deliveryId: "dlv-" + c.id(),
        messages: [{ type: "worker_done", taskId: done.task,
          payload: JSON.stringify(done.outcome == null ? {} : { outcome: done.outcome }) }] });
    },
  },
};
