// E21 nudge mid-run: the worker stalls — no worker_done ever arrives on its
// own, the preview is frozen, and the dispatch heartbeat is STALE (the fake's
// default dispatch-show always reports a fresh heartbeat; this override ages
// it). Nudge => the terminal handler writes the artifact and delivers the
// missing worker_done, and the step settles succeeded.
module.exports = {
  handlers: {
    // NOTE: "orchestration check" stays DEFAULT. worker-start pushes no done,
    // so the default handler already answers every pre-nudge wait with an
    // empty list (the stall) — and, crucially, DELIVERS the worker_done the
    // nudge handler pushes. An `messages: []` override here would swallow
    // that recovery done and the member would ride to the hard cap.
    "orchestration dispatch-show": (c) =>
      c.ok({ dispatch: { status: "dispatching", last_heartbeat_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() } }),
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.state.nudgeTask = c.flags.task;
      c.ok({ dispatchId: id, state: "ready" });       // NO pushDone: stalled mid-run
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-mid", lastOutputAt: Date.now() - 30 * 60 * 1000, preview: "frozen mid-work screen" } }),
    "terminal send": (c) => {
      const text = String(c.flags.text ?? "");
      const m = text.match(/\.orca\/artifacts\/([\w.\-]+)/);
      if (text.includes("[orca-flow]") && m) {
        const fs = require("node:fs"), { join } = require("node:path");
        const dir = join(process.env.ORCA_FAKE_WT || ".", ".orca", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, m[1]),
          "# Recovered\n\nMid-run nudge recovery filler clearing the readiness minimum-size check.\n".repeat(4));
        c.pushDone(c.state.nudgeTask, "succeeded");
      }
      c.ok({});
    },
  },
};
