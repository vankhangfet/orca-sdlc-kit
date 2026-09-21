// Runtime-down: every "orca status" fails, so the flow dies at its readiness
// check — AFTER the startup agent-config self-heal, BEFORE any group runs.
module.exports = {
  handlers: {
    "status": (c) => c.fail("runtime down (scenario)"),
  },
};
