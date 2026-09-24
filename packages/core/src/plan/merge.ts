/** A shell word as typed: bare when safe, else single-quoted. */
const shellWord = (word: string): string => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)

/**
 * The exact commands that bring an accepted task's work into the base branch (w1d): commit what its copy still holds
 * (when it does), then merge the branch in the main checkout, which has the base checked out. Browser-safe: the
 * screen and `crewboard attention` show the same lines. Crewboard prints them; a person or the orchestrator runs them.
 */
export function mergeCommands(o: { root: string; taskId: string; branch: string; path?: string; uncommitted?: number }): string[] {
  const path = o.path ? shellWord(o.path) : undefined
  return [
    ...(o.uncommitted && path ? [`git -C ${path} add -A`, `git -C ${path} commit -m ${shellWord(`crewboard: ${o.taskId}`)}`] : []),
    `git -C ${shellWord(o.root)} merge --no-ff ${shellWord(o.branch)}`,
  ]
}
