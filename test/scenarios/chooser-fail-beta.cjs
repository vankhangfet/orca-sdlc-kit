// Run-history tests: alpha succeeds (artifact materialized), beta FAILS with
// no artifact — leaves an incomplete run whose resume point is beta.
module.exports = {
  outcomeOf: (task) => (/^# Beta/m.test(task.spec || "") ? "failed" : "succeeded"),
};
