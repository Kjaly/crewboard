import { spawn } from 'node:child_process'
import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Exec } from '../exec.js'
import { loadPlan } from '../plan/store.js'
import { readEvidence } from '../runs/evidence.js'
import { exampleFilePath } from '../plan/example.js'
import { DetailError } from './detail.js'

export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
export type FileSide = 'before' | 'after'
export class FilePreviewError extends Error {
  constructor(readonly code: 'no_before' | 'unavailable' | 'too_large', message: string) { super(message) }
}

function safePath(root: string, file: string): string | undefined {
  if (!file || file.includes('\\') || file.split('/').some((part) => part === '..' || part === '.' || !part)) return undefined
  const path = resolve(root, file)
  const rel = relative(root, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? path : undefined
}

async function gitBytes(root: string, rev: string, file: string): Promise<Buffer | undefined> {
  return new Promise<Buffer | undefined>((done, reject) => {
    const child = spawn('git', ['-C', root, 'show', rev + ':' + file], { stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_PREVIEW_BYTES) { tooLarge = true; child.kill(); return }
      chunks.push(chunk)
    })
    child.on('error', () => done(undefined))
    child.on('close', (code) => {
      if (tooLarge) reject(new FilePreviewError('too_large', 'File exceeds preview limit'))
      else done(code === 0 ? Buffer.concat(chunks) : undefined)
    })
  })
}

export async function getTaskFile(root: string, taskId: string, file: string, side: FileSide, exec: Exec): Promise<Buffer> {
  const plan = await loadPlan(root)
  const task = plan.tasks.find((item) => item.id === taskId)
  if (!task) throw new DetailError('unknown_task', { id: taskId })
  if (plan.example) {
    const evidence = await readEvidence(root, task.runs.at(-1)?.evidence)
    if (!evidence?.files.some((item) => item.path === file)) throw new DetailError('unknown_file', { file })
    if (side === 'before') throw new FilePreviewError('no_before', 'No earlier version')
    const bytes = await readFile(exampleFilePath(root, taskId, file))
    if (bytes.length > MAX_PREVIEW_BYTES) throw new FilePreviewError('too_large', 'File exceeds preview limit')
    return bytes
  }
  if (!task.worktree) throw new DetailError('no_worktree', { id: taskId })
  const wt = task.worktree.path
  const path = safePath(wt, file)
  if (!path) throw new DetailError('unknown_file', { file })
  const live = await stat(wt).then((s) => s.isDirectory(), () => false)
  const evidence = await readEvidence(root, task.runs.at(-1)?.evidence)
  // Once the task branch is in the repository's history, the accepted range lives in git objects:
  // a live worktree of a merged branch has nothing left to diff against the repository HEAD.
  const accepted = await acceptedRange(root, task.worktree.branch, exec)
  const acceptedAfter = accepted?.after
  const acceptedBefore = accepted?.before
  const fromHistory = Boolean(accepted) || !live
  let base: string | undefined
  let allowed = evidence?.files.some((item) => item.path === file) ?? false
  if (!fromHistory) {
    const head = await exec('git', ['-C', root, 'rev-parse', 'HEAD'])
    const merge = head.code === 0 ? await exec('git', ['-C', wt, 'merge-base', 'HEAD', head.stdout.trim()]) : undefined
    base = merge?.code === 0 ? merge.stdout.trim() : undefined
    if (base) {
      const [tracked, untracked] = await Promise.all([
        exec('git', ['-C', wt, 'diff', '--name-only', '-z', base]),
        exec('git', ['-C', wt, 'ls-files', '--others', '--exclude-standard', '-z']),
      ])
      allowed ||= (tracked.code === 0 && tracked.stdout.split('\0').includes(file)) || (untracked.code === 0 && untracked.stdout.split('\0').includes(file))
    }
  } else {
    if (!allowed && acceptedBefore && acceptedAfter) {
      const changed = await exec('git', ['-C', root, 'diff', '--name-only', '-z', acceptedBefore, acceptedAfter])
      allowed = changed.code === 0 && changed.stdout.split('\0').includes(file)
    }
  }
  if (!allowed) throw new DetailError('unknown_file', { file })
  if (side === 'before') {
    if (fromHistory && !acceptedBefore) throw new FilePreviewError('unavailable', 'The task copy was cleaned up')
    if (!fromHistory && !base) throw new FilePreviewError('unavailable', 'The task base is unknown')
    const bytes = await gitBytes(fromHistory ? root : wt, fromHistory ? acceptedBefore! : base!, file)
    if (!bytes) throw new FilePreviewError('no_before', 'File is new')
    return bytes
  }
  if (!fromHistory) {
    const item = await lstat(path).catch(() => undefined)
    if (!item || !item.isFile()) throw new FilePreviewError('unavailable', 'File is unavailable')
    const actual = await realpath(path)
    const rel = relative(await realpath(wt), actual)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new DetailError('unknown_file', { file })
    if (item.size > MAX_PREVIEW_BYTES) throw new FilePreviewError('too_large', 'File exceeds preview limit')
    const bytes = await readFile(path)
    if (bytes.length > MAX_PREVIEW_BYTES) throw new FilePreviewError('too_large', 'File exceeds preview limit')
    return bytes
  }
  if (acceptedAfter) {
    const bytes = await gitBytes(root, acceptedAfter, file)
    if (bytes) return bytes
  }
  throw new FilePreviewError('unavailable', 'The task copy was cleaned up')
}

/**
 * The accepted range of a task branch that is already part of the repository HEAD: the merge commit
 * that names the branch (before = its first parent, after = the merge), or, after a fast-forward,
 * the branch tip and the commit it was created from. Undefined while the branch is not merged.
 */
async function acceptedRange(root: string, branch: string, exec: Exec): Promise<{ before?: string; after: string } | undefined> {
  const head = await exec('git', ['-C', root, 'rev-parse', 'HEAD'])
  if (head.code !== 0) return undefined
  const tip = await exec('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/' + branch])
  const history = await exec('git', ['-C', root, 'log', '--merges', '--format=%H%x00%B%x00', head.stdout.trim()])
  const entries = history.code === 0 ? history.stdout.split('\0') : []
  for (let i = 0; i + 1 < entries.length; i += 2) {
    const message = entries[i + 1] ?? ''
    if (new RegExp(`(^|[\\s'"])${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['"\\s]|$)`).test(message)) {
      const merge = entries[i]!.trim()
      return { before: merge + '^1', after: merge }
    }
  }
  if (tip.code !== 0) return undefined
  const ancestor = await exec('git', ['-C', root, 'merge-base', '--is-ancestor', tip.stdout.trim(), head.stdout.trim()])
  if (ancestor.code !== 0) return undefined
  const reflog = await exec('git', ['-C', root, 'reflog', 'show', '--format=%H', branch])
  const created = reflog.code === 0 ? reflog.stdout.trim().split('\n').filter(Boolean).at(-1) : undefined
  // A branch with no commits of its own sits on HEAD without having been accepted into it.
  if (created === tip.stdout.trim()) return undefined
  return { ...(created ? { before: created } : {}), after: tip.stdout.trim() }
}
