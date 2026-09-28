import { nodeExec } from '../exec.js'

/**
 * Changed, added and deleted files in the copy that are not committed (Crewboard's own files aside); undefined when
 * git cannot tell. Its own file with no other imports (w1d, cm1): the run supervisor (cli-runner.ts) needs this one
 * check without pulling in evidence.ts's much heavier dependencies (the verdict's multi-language parsing, the
 * contract's checks) into its own small bundle.
 */
export async function uncommittedFiles(wt: string): Promise<number | undefined> {
  const status = await nodeExec('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':(exclude).orchestration']).catch(() => undefined)
  if (!status || status.code) return undefined
  return status.stdout.split('\n').filter(Boolean).length
}
