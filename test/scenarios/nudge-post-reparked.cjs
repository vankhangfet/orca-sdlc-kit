// E26 nudge-post-reparked: the first post-done nudge lands (preview clean),
// the terminal then PARKS on a folder-trust dialog before the re-nudge is
// due. The re-nudge must NOT be typed into the dialog — the step settles
// with the original outcome and the "(terminal parked on ...)" note.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.pushDone(c.flags.task, "succeeded");          // done, but NO materialize
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-repark", lastOutputAt: Date.now() } }),
    "terminal show": (c) => c.ok({ terminal: { preview: c.state.reparked
      ? "claude code\r\nQuick safety check — Yes, I trust this folder"
      : "agent idle at prompt" } }),
    "terminal send": (c) => {
      const text = String(c.flags.text ?? "");
      if (text.includes("[orca-flow]")) c.state.reparked = true;   // dialog parks after the first nudge
      c.ok({});                                                    // and the file is never written
    },
  },
};
