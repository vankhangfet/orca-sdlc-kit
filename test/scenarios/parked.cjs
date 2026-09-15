// E6 parked-prompt: frozen preview carrying a permission-dialog signature.
// The flow must WARN once with the specific label, NEVER answer the prompt
// itself, and keep waiting to the hard cap (#4 semantics).
module.exports = {
  handlers: {
    "orchestration check": (c) => c.ok({ messages: [] }),
    "orchestration worker-show": (c) => c.ok({ terminal: { preview: "claude code\r\nBash command requires confirmation for this command. Do you want to proceed? (y/n)" } }),
  },
};
