// E4 hardcap: the dispatch stays alive forever and the preview renders once
// then FREEZES (busy-looking but silent). worker_done never arrives — the run
// MUST settle via hardTimeoutMs and exit with the resume hint.
module.exports = {
  handlers: {
    "orchestration check": (c) => c.ok({ messages: [] }),
    "orchestration worker-show": (c) => c.ok({ terminal: { preview: "claude code - working on the task..." } }),
  },
};
