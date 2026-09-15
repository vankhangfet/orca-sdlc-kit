// E5 quiet-warn: NO preview at all and a heartbeat one hour stale — silence
// grows while the dispatch is alive: exactly ONE warning, then the hard cap
// (never a premature failure, never a spam loop).
module.exports = {
  handlers: {
    "orchestration check": (c) => c.ok({ messages: [] }),
    "orchestration dispatch-show": (c) => c.ok({ dispatch: { status: "dispatching", last_heartbeat_at: new Date(Date.now() - 3600000).toISOString() } }),
    "orchestration worker-show": (c) => c.ok({ terminal: { lastOutputAt: Date.now() - 3600000 } }),
  },
};
