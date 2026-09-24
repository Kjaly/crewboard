/**
 * Cleanup reason codes are the wire value; only policy values below need the Russian dictionary.
 */

/**
 * Wire values of the cleanup policy. They are stored in `worktrees.json` and validated by core,
 * so they are taken from the Russian dictionary verbatim: the value is data and must not follow
 * the interface language. The English dictionary holds the labels for these same options.
 */
// From core, the one owner of the wire values; importing the dictionary pulled it into screen bundles.
export { WORKTREE_POLICIES } from '../../../core/src/worktree/policy.js'
