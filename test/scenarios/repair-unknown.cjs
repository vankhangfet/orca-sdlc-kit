// E14b readiness-unknown: the default worker-start handler runs (outcomeOf
// hook), the worker settles with NO outcome and writes no artifact — a
// silent worker mid-repair must not be blindly re-dispatched.
module.exports = {
  outcomeOf: () => null,
  handlers: {},
};
