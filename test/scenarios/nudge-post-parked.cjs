// E25 nudge-post-parked: worker_done(succeeded) without the artifact, but
// the terminal is PARKED on a dialog (folder-trust). The flow must NOT send
// anything into that dialog — the step settles with the original outcome
// and a "(terminal parked on ...)" note.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.pushDone(c.flags.task, "succeeded");          // done, but NO materialize
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-post-parked", lastOutputAt: Date.now() } }),
    "terminal show": (c) =>
      c.ok({ terminal: { preview: "claude code\r\nQuick safety check — Yes, I trust this folder" } }),
    "terminal send": () => { /* must never be reached */ },
  },
};
