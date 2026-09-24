import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeExec } from '../src/exec.js'

/** Returns a real path: on macOS tmpdir() is /var/… while git reports /private/var/…. */
export async function makeRepo(): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'orch-git-')))
  const root = join(parent, 'repo')
  const git = (...args: string[]) => nodeExec('git', ['-C', root, ...args])
  await nodeExec('git', ['init', '-q', '-b', 'main', root])
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'user.name', 'Test')
  await writeFile(join(root, 'README.txt'), 'hello\n')
  await git('add', '.')
  await git('commit', '-q', '-m', 'init')
  return root
}
