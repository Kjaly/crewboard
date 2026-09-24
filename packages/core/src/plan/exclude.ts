import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { CREWBOARD_DIR } from './store.js'

/** Adds `.orchestration/` to .git/info/exclude. Returns true when the line was added. */
export async function ensureGitExclude(root: string, exec: Exec): Promise<boolean> {
  const r = await exec('git', ['-C', root, 'rev-parse', '--git-path', 'info/exclude'])
  if (r.code !== 0) throw new Error(`not a git repository: ${root}`)
  const file = resolve(root, r.stdout.trim())
  const line = `${CREWBOARD_DIR}/`
  const current = await readFile(file, 'utf8').catch(() => '')
  if (current.split('\n').some((l) => l.trim() === line)) return false
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`)
  return true
}
