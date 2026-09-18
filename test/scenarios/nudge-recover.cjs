// E19 nudge-recover: the worker sends worker_done(succeeded) WITHOUT writing
// its artifact (default worker-start materializes on success — replaced
// wholesale per fake-orca's contract). The nudge ("terminal send" carrying
// "[orca-flow] ... now") is answered the way a compliant agent would: write
// the file, then send worker_done again. worker-show exposes a terminal id
// so the cold-path dispatch can be nudged.
module.exports = {
  handlers: {
    "orchestration worker-start": (c) => {
      const id = "disp-" + c.id();
      c.state.dispatches[id] = { id, task: c.flags.task, status: "dispatching", created: Date.now() };
      c.state.nudgeTask = c.flags.task;               // one-step config: remember whose nudge this is
      c.pushDone(c.flags.task, "succeeded");          // done, but NO materialize
      c.ok({ dispatchId: id, state: "ready" });
    },
    "orchestration worker-show": (c) =>
      c.ok({ terminal: { id: "term-nudge", lastOutputAt: Date.now(), preview: "agent idle at prompt" } }),
    "terminal send": (c) => {
      const text = String(c.flags.text ?? "");
      const m = text.match(/\.orca\/artifacts\/([\w.\-]+)/);
      if (text.includes("[orca-flow]") && m) {
        const fs = require("node:fs"), { join } = require("node:path");
        const dir = join(process.env.ORCA_FAKE_WT || ".", ".orca", "artifacts");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(join(dir, m[1]),
          "# Recovered\n\nArtifact written after the nudge; filler clearing the readiness minimum-size check.\n".repeat(4));
        c.pushDone(c.state.nudgeTask, "succeeded");   // a further done while held must not missettle
      }
      c.ok({});
    },
  },
};
