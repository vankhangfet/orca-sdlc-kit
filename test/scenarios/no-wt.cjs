// Auto-detect failure: the invoking directory reports no Orca-managed worktree
// (`orca worktree current` exits non-zero), the trigger for auto-create.
module.exports = { handlers: { "worktree current": (c) => c.fail("not inside an Orca-managed worktree") } };
