// E10 unknown-outcome: worker_done arrives with an EMPTY payload — the flow
// must NOT blind-retry (double-dispatch guard) and must die with
// outcome=unknown.
module.exports = {
  outcomeOf: () => null,
};
