// E9 gate-approve: the first gate-list poll still sees the gate pending; the
// second reports a "yes" resolution — the run must unblock and finish.
module.exports = {
  init: (s) => { s.extra.gateListCalls = 0; },
  handlers: {
    "orchestration gate-list": (c) => {
      c.state.extra.gateListCalls++;
      const g = (c.state.gates[0] || {}).id || "gate-1";
      if (c.state.extra.gateListCalls === 1) return c.ok({ gates: [{ id: g, status: "pending" }] });
      c.ok({ gates: [{ id: g, status: "resolved", resolution: "yes" }] });
    },
  },
};
