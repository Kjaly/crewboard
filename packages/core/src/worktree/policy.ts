/**
 * Wire values of the cleanup policy, stored in `worktrees.json`. They are data, not interface text,
 * and stay the same whatever the interface language. Free of Node imports so the browser client can
 * import this module directly.
 */
export const WORKTREE_POLICIES = ['после приёмки', 'по команде', 'не убирать'] as const
export type WorktreePolicy = (typeof WORKTREE_POLICIES)[number]
export const DEFAULT_WORKTREE_POLICY: WorktreePolicy = 'после приёмки'
