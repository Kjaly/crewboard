import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { acceptTask } from '../src/orchestration/review.js'
import { type Plan, type StoredStatus, newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { createPlan, setCurrentPlan, setPlanArchived } from '../src/plan/plans.js'
import { gcAfterAccept, gcCandidates, gcRemove, gcRecheckAccepted, listOrchWorktrees, removeWorktree } from '../src/worktree/gc.js'
import { prepareWorktree } from '../src/worktree/prepare.js'
import { RecipeSchema } from '../src/worktree/recipe.js'
import { makeRepo } from './git-helpers.js'

async function setup(status: 'accepted' | 'ready', dirty: boolean) {
  const root = await makeRepo()
  const wt = await prepareWorktree({ repoRoot: root, taskId: 't1', title: 'task', recipe: RecipeSchema.parse({}), exec: nodeExec })
  if (dirty) await writeFile(join(wt.path, 'scratch.txt'), 'x')
  const plan: Plan = {
    version: 1,
    goal: 'g',
    rev: 0,
    updatedAt: 'now',
    tasks: [{ ...newTask({ id: 't1', title: 'task' }), status, worktree: { path: wt.path, branch: wt.branch } }],
  }
  return { root, wt, plan }
}
const gone = (p: string) => stat(p).then(() => false, () => true)

type Spec = {
  id: string
  status: StoredStatus
  /** When present the task carries an «accept» note with this timestamp — the recency order. */
  acceptAt?: string
  dirty?: boolean
  /** A commit in the copy that is not merged into main makes the branch unmerged. */
  commit?: boolean
  running?: boolean
}

async function setupPlan(specs: Spec[]) {
  const root = await makeRepo()
  await initPlan(root, 'g', new Date('2026-09-22T10:00:00Z'))
  const copies = new Map<string, { path: string; branch: string }>()
  for (const spec of specs) {
    const wt = await prepareWorktree({ repoRoot: root, taskId: spec.id, title: spec.id, recipe: RecipeSchema.parse({}), exec: nodeExec })
    copies.set(spec.id, { path: wt.path, branch: wt.branch })
    if (spec.commit) {
      await writeFile(join(wt.path, `${spec.id}.txt`), 'x\n')
      await nodeExec('git', ['-C', wt.path, 'add', '.'])
      await nodeExec('git', ['-C', wt.path, 'commit', '-q', '-m', `work ${spec.id}`])
    }
    if (spec.dirty) await writeFile(join(wt.path, 'scratch.txt'), 'x\n')
  }
  await updatePlan(root, (plan) => {
    plan.tasks = specs.map((spec) => ({
      ...newTask({ id: spec.id, title: spec.id }),
      status: spec.status,
      worktree: copies.get(spec.id)!,
      ...(spec.acceptAt ? { notes: [{ at: spec.acceptAt, type: 'accept' as const, text: 'принято' }] } : {}),
      ...(spec.running ? { runs: [{ runId: `run_${spec.id}`, agent: 'dsh', startedAt: '2026-09-22T09:00:00Z' }] } : {}),
    }))
    return plan
  })
  return { root, copies }
}

const deps = (now = new Date('2026-09-22T12:00:00Z')) => ({ exec: nodeExec, now: () => now })

describe('worktree gc', () => {
  it('marks only clean worktrees of accepted tasks as removable', async () => {
    const a = await setup('accepted', false)
    const b = await setup('accepted', true)
    const c = await setup('ready', false)
    expect((await listOrchWorktrees(a.plan, nodeExec))[0]).toMatchObject({ exists: true, dirty: false, accepted: true, removable: true })
    expect((await listOrchWorktrees(b.plan, nodeExec))[0]).toMatchObject({ dirty: true, removable: false })
    expect((await listOrchWorktrees(c.plan, nodeExec))[0]).toMatchObject({ accepted: false, removable: false })
  })

  it('removes a removable worktree and its merged branch', async () => {
    const { root, wt, plan } = await setup('accepted', false)
    const [info] = await listOrchWorktrees(plan, nodeExec)
    if (!info) throw new Error('no worktree info')
    expect(await removeWorktree(root, info, nodeExec)).toEqual({ branchDeleted: true })
    expect(await gone(wt.path)).toBe(true)
  })

  it('refuses a dirty worktree without force and removes it with force', async () => {
    const { root, wt, plan } = await setup('accepted', true)
    const [info] = await listOrchWorktrees(plan, nodeExec)
    if (!info) throw new Error('no worktree info')
    await expect(removeWorktree(root, info, nodeExec)).rejects.toThrow(/незакоммиченные/)
    await removeWorktree(root, info, nodeExec, { force: true })
    expect(await gone(wt.path)).toBe(true)
  })
})

describe('gcCandidates', () => {
  it('reports dirty files and artefact-only status and lists orphans without removing them', async () => {
    const { root, copies } = await setupPlan([{ id: 'dirty', status: 'accepted' }])
    await writeFile(join(root, '.gitignore'), 'dist/\n')
    await mkdir(join(copies.get('dirty')!.path, 'dist'), { recursive: true })
    await writeFile(join(copies.get('dirty')!.path, 'dist', 'junk.js'), 'x')
    const orphan = join(root, '..', `${root.split('/').at(-1)}-orch-lost`)
    await import('node:fs/promises').then(({ mkdir, writeFile: put }) => mkdir(orphan, { recursive: true }).then(() => put(join(orphan, 'kept.txt'), 'work')))
    const candidates = await gcCandidates(root, deps())
    expect(candidates.find((c) => c.taskId === 'dirty')).toMatchObject({ keep: 'dirty', modifiedCount: 0, untrackedCount: 1, dirtyPaths: ['dist/junk.js'], artefactOnly: true })
    expect(candidates.find((c) => c.orphan)).toMatchObject({ keep: 'orphan', orphan: true })
    expect(await gone(orphan)).toBe(false)
  })

  it('finds copies in non-current archived plans', async () => {
    const { root, copies } = await setupPlan([{ id: 'maincopy', status: 'accepted' }])
    const other = await createPlan(root, 'archive-plan', 'archived', new Date('2026-09-20T10:00:00Z'))
    const wt = await prepareWorktree({ repoRoot: root, taskId: 'oldcopy', title: 'old', recipe: RecipeSchema.parse({}), exec: nodeExec })
    other.tasks.push({ ...newTask({ id: 'oldcopy', title: 'old' }), status: 'accepted', worktree: { path: wt.path, branch: wt.branch }, notes: [{ at: '2026-09-20T10:00:00Z', type: 'accept', text: 'ok' }] })
    await updatePlan(root, () => other, 5, 'archive-plan')
    await setPlanArchived(root, 'archive-plan', true)
    await setCurrentPlan(root, 'main')
    expect((await gcCandidates(root, deps())).find((c) => c.taskId === 'oldcopy')).toMatchObject({ planId: 'archive-plan', path: wt.path })
    expect(copies.has('maincopy')).toBe(true)
  })

  it('finds the eligible copy and names the reason every other one stays', async () => {
    // a1 is the oldest accepted copy, so it falls out of KEEP_RECENT; the rest are blocked on their own.
    const { root, copies } = await setupPlan([
      { id: 'a1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'a2', status: 'accepted', acceptAt: '2026-09-22T12:00:00Z' },
      { id: 'a3', status: 'accepted', acceptAt: '2026-09-22T12:01:00Z' },
      { id: 'a4', status: 'accepted', acceptAt: '2026-09-22T12:02:00Z' },
      { id: 'dirty', status: 'accepted', acceptAt: '2026-09-22T11:30:00Z', dirty: true },
      { id: 'unmerged', status: 'accepted', acceptAt: '2026-09-22T11:40:00Z', commit: true },
      { id: 'run', status: 'ready', running: true },
    ])
    const byId = new Map((await gcCandidates(root, deps())).map((c) => [c.taskId, c]))

    const candidate = byId.get('a1')
    expect(candidate).toMatchObject({ path: copies.get('a1')!.path, branch: copies.get('a1')!.branch })
    expect(candidate?.keep).toBeUndefined()
    expect(typeof candidate?.sizeBytes).toBe('number')
    expect(byId.get('dirty')?.keep).toBe('dirty')
    expect(byId.get('unmerged')?.keep).toBe('unmerged')
    expect(byId.get('run')?.keep).toBe('running')
    expect(byId.get('a2')?.keep).toBe('recent')
    expect(byId.get('a3')?.keep).toBe('recent')
    expect(byId.get('a4')?.keep).toBe('recent')
  })

  it('keeps the three most recently accepted copies even when they qualify', async () => {
    const { root } = await setupPlan([
      { id: 'a1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'a2', status: 'accepted', acceptAt: '2026-09-22T11:01:00Z' },
      { id: 'a3', status: 'accepted', acceptAt: '2026-09-22T11:02:00Z' },
      { id: 'a4', status: 'accepted', acceptAt: '2026-09-22T11:03:00Z' },
    ])
    const candidates = await gcCandidates(root, deps())
    expect(candidates.filter((c) => c.keep === 'recent').map((c) => c.taskId).sort()).toEqual(['a2', 'a3', 'a4'])
    expect(candidates.filter((c) => !c.keep).map((c) => c.taskId)).toEqual(['a1'])
  })
})

describe('gcRemove', () => {
  it('leaves the dirty copy in failed with its reason and removes the rest', async () => {
    const { root, copies } = await setupPlan([
      { id: 'dirty', status: 'accepted', dirty: true },
      { id: 'clean', status: 'accepted', acceptAt: '2026-09-22T10:00:00Z' },
      { id: 'new1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'new2', status: 'accepted', acceptAt: '2026-09-22T11:01:00Z' },
      { id: 'new3', status: 'accepted', acceptAt: '2026-09-22T11:02:00Z' },
    ])
    const result = await gcRemove(root, ['dirty', 'clean'], { exec: nodeExec })
    expect(result.removed).toEqual(['clean'])
    expect(result.failed).toEqual([{ taskId: 'dirty', reason: 'dirty' }])
    expect(await gone(copies.get('clean')!.path)).toBe(true)
    expect(await gone(copies.get('dirty')!.path)).toBe(false)
    const branch = await nodeExec('git', ['-C', root, 'branch', '--list', copies.get('clean')!.branch])
    expect(branch.stdout.trim()).toBe('')
  })

  it('refuses an unmerged branch and an unaccepted task', async () => {
    const { root } = await setupPlan([
      { id: 'unmerged', status: 'accepted', acceptAt: '2026-09-22T10:00:00Z', commit: true },
      { id: 'new1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'new2', status: 'accepted', acceptAt: '2026-09-22T11:01:00Z' },
      { id: 'new3', status: 'accepted', acceptAt: '2026-09-22T11:02:00Z' },
      { id: 'ready', status: 'ready' },
    ])
    const result = await gcRemove(root, ['unmerged', 'ready'], { exec: nodeExec })
    expect(result.removed).toEqual([])
    expect(result.failed.map((f) => f.taskId).sort()).toEqual(['ready', 'unmerged'])
    expect(result.failed.find((f) => f.taskId === 'unmerged')?.reason).toBe('unmerged')
    expect(result.failed.find((f) => f.taskId === 'ready')?.reason).toBe('rejected')
  })
})

describe('gcAfterAccept', () => {
  it('removes an accepted unmerged copy on a later recheck after merge', async () => {
    const { root, copies } = await setupPlan([
      { id: 'old', status: 'accepted', acceptAt: '2026-09-22T10:00:00Z', commit: true },
      { id: 'new1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'new2', status: 'accepted', acceptAt: '2026-09-22T11:01:00Z' },
      { id: 'new3', status: 'accepted', acceptAt: '2026-09-22T11:02:00Z' },
    ])
    const policyPath = join(root, '.orchestration', 'worktrees.json')
    const now = new Date('2026-09-23T12:00:00Z')
    await gcAfterAccept(root, ['old'], { exec: nodeExec, now: () => now, policyPath })
    expect((await gcRecheckAccepted(root, { exec: nodeExec, now: () => now, policyPath })).removed).toEqual([])
    await nodeExec('git', ['-C', root, 'merge', '--no-ff', '-q', copies.get('old')!.branch, '-m', 'accept old'])
    const result = await gcRecheckAccepted(root, { exec: nodeExec, now: () => now, policyPath })
    expect(result.removed).toContain('old')
    expect(await gone(copies.get('old')!.path)).toBe(true)
    expect((await loadPlan(root)).tasks.find((task) => task.id === 'old')?.notes.at(-1)?.text).toBe('Worktree removed after acceptance.')
  })

  it('rechecks every accepted copy, not only those that recorded a waiting note', async () => {
    const { root, copies } = await setupPlan([
      { id: 'old', status: 'accepted', acceptAt: '2026-09-22T10:00:00Z', commit: true },
      { id: 'new1', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'new2', status: 'accepted', acceptAt: '2026-09-22T11:01:00Z' },
      { id: 'new3', status: 'accepted', acceptAt: '2026-09-22T11:02:00Z' },
    ])
    const policyPath = join(root, '.orchestration', 'worktrees.json')
    const now = new Date('2026-09-23T12:00:00Z')
    // Accepted without gcAfterAccept (e.g. through another path), merged later by hand.
    await nodeExec('git', ['-C', root, 'merge', '--no-ff', '-q', copies.get('old')!.branch, '-m', 'accept old'])
    const result = await gcRecheckAccepted(root, { exec: nodeExec, now: () => now, policyPath })
    expect(result.removed).toEqual(['old'])
    expect(await gone(copies.get('old')!.path)).toBe(true)
  })

  it('keeps a recently accepted copy and writes one reason into the task feed', async () => {
    const { root, copies } = await setupPlan([{ id: 't1', status: 'in_review' }])
    const policyPath = join(root, '.orchestration', 'worktrees.json')
    const now = new Date('2026-09-22T12:30:00Z')
    const result = await gcAfterAccept(root, ['t1'], { exec: nodeExec, now: () => now, policyPath })
    // The callers accept first; gcAfterAccept only sees accepted copies.
    expect(result.removed).toEqual([])
    await acceptTask(root, 't1', now)
    const after = await gcAfterAccept(root, ['t1'], { exec: nodeExec, now: () => now, policyPath })
    expect(after.removed).toEqual([])
    expect(after.failed).toEqual([{ taskId: 't1', reason: 'recent' }])
    expect(await gone(copies.get('t1')!.path)).toBe(false)
    expect((await loadPlan(root)).tasks[0]?.notes.at(-1)).toMatchObject({ type: 'comment', event: { kind: 'worktree', outcome: 'kept_recent' } })
  })

  it('does nothing when the policy is «не убирать»', async () => {
    const { root, copies } = await setupPlan([{ id: 't1', status: 'in_review' }])
    const policyPath = join(root, '.orchestration', 'worktrees.json')
    await writeFile(policyPath, JSON.stringify({ version: 1, policy: 'не убирать' }))
    const result = await gcAfterAccept(root, ['t1'], { exec: nodeExec, now: () => new Date('2026-09-22T12:30:00Z'), policyPath })
    expect(result.removed).toEqual([])
    expect(await gone(copies.get('t1')!.path)).toBe(false)
  })

  it('keeps a just accepted copy when it is among the three most recent and records why', async () => {
    const specs: Spec[] = [
      { id: 'old', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'a', status: 'accepted', acceptAt: '2026-09-22T12:00:00Z' },
      { id: 'b', status: 'accepted', acceptAt: '2026-09-22T12:01:00Z' },
      { id: 'c', status: 'accepted', acceptAt: '2026-09-22T12:02:00Z' },
    ]
    const { root, copies } = await setupPlan(specs)
    const policyPath = join(root, '.orchestration', 'worktrees.json')
    const result = await gcAfterAccept(root, ['c'], { exec: nodeExec, now: () => new Date('2026-09-22T12:03:00Z'), policyPath })
    expect(result).toMatchObject({ removed: [], failed: [{ taskId: 'c', reason: 'recent' }] })
    expect(await gone(copies.get('c')!.path)).toBe(false)
    expect((await loadPlan(root)).tasks.find((task) => task.id === 'c')?.notes.at(-1)).toMatchObject({ type: 'comment', event: { kind: 'worktree', outcome: 'kept_recent' } })
  })

  it('accepting a fourth task removes only the oldest eligible copy', async () => {
    const { root, copies } = await setupPlan([
      { id: 'old', status: 'accepted', acceptAt: '2026-09-22T11:00:00Z' },
      { id: 'a', status: 'accepted', acceptAt: '2026-09-22T12:00:00Z' },
      { id: 'b', status: 'accepted', acceptAt: '2026-09-22T12:01:00Z' },
      { id: 'c', status: 'accepted', acceptAt: '2026-09-22T12:02:00Z' },
    ])
    const result = await gcRemove(root, ['old', 'c'], { exec: nodeExec })
    expect(result).toMatchObject({ removed: ['old'], failed: [{ taskId: 'c', reason: 'recent' }] })
    expect(await gone(copies.get('old')!.path)).toBe(true)
    expect(await gone(copies.get('c')!.path)).toBe(false)
  })
})
