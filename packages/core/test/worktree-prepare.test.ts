import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'
import { PrepareError, prepareWorktree, slugify, worktreeLocation } from '../src/worktree/prepare.js'
import { readWorktreeState } from '../src/worktree/state.js'
import { RecipeSchema, loadRecipe } from '../src/worktree/recipe.js'
import { makeRepo } from './git-helpers.js'

async function commitInRoot(root: string, file: string, text: string): Promise<void> {
  await mkdir(join(root, file, '..'), { recursive: true })
  await writeFile(join(root, file), text)
  await nodeExec('git', ['-C', root, 'add', file])
  await nodeExec('git', ['-C', root, 'commit', '-q', '-m', `change ${file}`])
}

describe('naming', () => {
  it('slugifies titles and falls back for non-latin text', () => {
    expect(slugify('Fix SSE shutdown!')).toBe('fix-sse-shutdown')
    expect(slugify('Фикстуры')).toBe('task')
  })
  it('places the worktree next to the repo', () => {
    expect(worktreeLocation('/w/joinory', 't07', 'Regression test')).toEqual({ path: '/w/joinory-orch-t07', branch: 'orch/t07-regression-test' })
  })
})

describe('loadRecipe', () => {
  it('returns null without a recipe and parses defaults', async () => {
    const root = await makeRepo()
    expect(await loadRecipe(root)).toBeNull()
    await mkdir(join(root, '.orchestration'))
    await writeFile(join(root, '.orchestration/recipes.json'), '{"setup":["echo hi"]}')
    expect(await loadRecipe(root)).toEqual({ setup: ['echo hi'], env: { unset: [] }, timeoutSec: 300 })
  })
})

describe('prepareWorktree', () => {
  it('creates the worktree, runs steps, copies artefacts and runs the baseline', async () => {
    const root = await makeRepo()
    await mkdir(join(root, 'generated'))
    await writeFile(join(root, 'generated/api.ts'), 'export {}\n')
    const recipe = RecipeSchema.parse({
      setup: ['echo ready > prepared.txt', { copy: 'generated' }, 'test -z "$HTTP_PROXY"'],
      env: { unset: ['HTTP_PROXY'] },
      baseline: 'test -f prepared.txt && test -f generated/api.ts && echo scope={scope}',
    })
    const r = await prepareWorktree({
      repoRoot: root,
      taskId: 't1',
      title: 'First task',
      recipe,
      scope: 'web',
      exec: nodeExec,
      env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1082' },
    })
    expect(r).toMatchObject({ reused: false, branch: 'orch/t1-first-task' })
    expect(r.steps.map((s) => s.ok)).toEqual([true, true, true])
    expect(r.baseline).toMatchObject({ ok: true })
    expect(r.baseline?.output).toContain('scope=web')
    expect(await readFile(join(r.path, 'prepared.txt'), 'utf8')).toBe('ready\n')

    const again = await prepareWorktree({ repoRoot: root, taskId: 't1', title: 'First task', recipe, scope: 'web', exec: nodeExec })
    expect(again).toMatchObject({ reused: true, steps: [] })
    // Green on this repository HEAD with the same command: the reuse does not pay for the baseline again.
    expect(again.baseline).toBeUndefined()
    expect(again.record).toMatchObject({ ok: true, command: 'test -f prepared.txt && test -f generated/api.ts && echo scope=web' })
  })

  it('brings a reused worktree up to the repository HEAD', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({})
    const first = await prepareWorktree({ repoRoot: root, taskId: 't9', title: 'Stale copy', recipe, exec: nodeExec })
    expect(first.reused).toBe(false)

    // The plan changes in the repository after the copy was branched off.
    await writeFile(join(root, 'plan.md'), 'вторая версия плана\n')
    await nodeExec('git', ['-C', root, 'add', 'plan.md'])
    await nodeExec('git', ['-C', root, 'commit', '-m', 'rewrite the plan'])

    const again = await prepareWorktree({ repoRoot: root, taskId: 't9', title: 'Stale copy', recipe, exec: nodeExec })
    expect(again.reused).toBe(true)
    expect(again.steps.at(-1)).toMatchObject({ ok: true })
    expect(await readFile(join(again.path, 'plan.md'), 'utf8')).toBe('вторая версия плана\n')
  })

  it('leaves a reused worktree alone when a tracked file is modified', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({})
    const first = await prepareWorktree({ repoRoot: root, taskId: 't10', title: 'Busy copy', recipe, exec: nodeExec })
    await writeFile(join(first.path, 'README.txt'), 'работа воркера\n')
    await commitInRoot(root, 'plan.md', 'новая версия\n')

    const again = await prepareWorktree({ repoRoot: root, taskId: 't10', title: 'Busy copy', recipe, exec: nodeExec })
    expect(again.steps.at(-1)).toMatchObject({ step: expect.stringContaining('update the copy to'), ok: false })
    expect(again.steps.at(-1)?.output).toContain('README.txt')
    expect(await readFile(join(again.path, 'README.txt'), 'utf8')).toBe('работа воркера\n')
    await expect(readFile(join(again.path, 'plan.md'), 'utf8')).rejects.toThrow()
  })

  it('names a few blocking paths and counts the rest, in English and Russian', async () => {
    const root = await makeRepo()
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await commitInRoot(root, `f${n}.txt`, 'v1\n')
    const recipe = RecipeSchema.parse({})
    const first = await prepareWorktree({ repoRoot: root, taskId: 'r4', title: 'Many edits', recipe, exec: nodeExec })
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await writeFile(join(first.path, `f${n}.txt`), 'edited\n')
    await commitInRoot(root, 'plan.md', 'next\n')

    const en = (await prepareWorktree({ repoRoot: root, taskId: 'r4', title: 'Many edits', recipe, exec: nodeExec, lang: 'en' })).steps.at(-1)
    expect(en?.output).toMatch(/^The copy has uncommitted changes .*f1\.txt, f2\.txt, f3\.txt, f4\.txt, f5\.txt and 2 more$/)
    const ru = (await prepareWorktree({ repoRoot: root, taskId: 'r4', title: 'Many edits', recipe, exec: nodeExec, lang: 'ru' })).steps.at(-1)
    expect(ru?.step).toMatch(/^обновление копии до [0-9a-f]{7}$/)
    expect(ru?.output).toMatch(/^В копии есть незакоммиченные изменения .*f5\.txt и ещё 2$/)
  })

  it('fast-forwards a reused worktree past untracked setup files that do not collide (rf1)', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ setup: ['echo ready > prepared.txt', 'mkdir -p .venv/bin && echo py > .venv/bin/python'] })
    const first = await prepareWorktree({ repoRoot: root, taskId: 'r1', title: 'Setup artefacts', recipe, exec: nodeExec })
    await writeFile(join(first.path, 'draft.txt'), 'работа воркера\n')
    await commitInRoot(root, 'plan.md', 'вторая версия плана\n')

    const again = await prepareWorktree({ repoRoot: root, taskId: 'r1', title: 'Setup artefacts', recipe, exec: nodeExec })
    expect(again.steps.at(-1)).toMatchObject({ ok: true })
    expect(await readFile(join(again.path, 'plan.md'), 'utf8')).toBe('вторая версия плана\n')
    expect(await readFile(join(again.path, 'prepared.txt'), 'utf8')).toBe('ready\n')
    expect(await readFile(join(again.path, 'draft.txt'), 'utf8')).toBe('работа воркера\n')
    expect(await readFile(join(again.path, '.venv/bin/python'), 'utf8')).toBe('py\n')
  })

  it('blocks when an incoming commit adds a path the copy has untracked, naming it', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({})
    const first = await prepareWorktree({ repoRoot: root, taskId: 'r2', title: 'Collision', recipe, exec: nodeExec })
    await writeFile(join(first.path, 'marker.txt'), 'local\n')
    await mkdir(join(first.path, 'build'))
    await writeFile(join(first.path, 'build/out.js'), 'local\n')
    await writeFile(join(first.path, 'free.txt'), 'local\n')
    await commitInRoot(root, 'marker.txt', 'incoming\n')
    await commitInRoot(root, 'build/out.js', 'incoming\n')

    const again = await prepareWorktree({ repoRoot: root, taskId: 'r2', title: 'Collision', recipe, exec: nodeExec, lang: 'ru' })
    const step = again.steps.at(-1)
    expect(step).toMatchObject({ step: expect.stringContaining('обновление копии до'), ok: false })
    expect(step?.output).toContain('marker.txt')
    expect(step?.output).toContain('build/')
    expect(step?.output).not.toContain('free.txt')
    expect(await readFile(join(again.path, 'marker.txt'), 'utf8')).toBe('local\n')
    expect(await readFile(join(again.path, 'build/out.js'), 'utf8')).toBe('local\n')
  })

  it('leaves a copy whose merge conflicts as it was, not mid-merge', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({})
    const first = await prepareWorktree({ repoRoot: root, taskId: 'r3', title: 'Conflict', recipe, exec: nodeExec })
    await writeFile(join(first.path, 'README.txt'), 'worker\n')
    await nodeExec('git', ['-C', first.path, 'commit', '-q', '-am', 'worker'])
    await commitInRoot(root, 'README.txt', 'main\n')

    const again = await prepareWorktree({ repoRoot: root, taskId: 'r3', title: 'Conflict', recipe, exec: nodeExec })
    expect(again.steps.at(-1)).toMatchObject({ ok: false })
    expect((await nodeExec('git', ['-C', again.path, 'status', '--porcelain'])).stdout).toBe('')
    expect(await readFile(join(again.path, 'README.txt'), 'utf8')).toBe('worker\n')
  })

  it('stops at the first failing step', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ setup: ['exit 4', 'echo never > never.txt'] })
    const err = await prepareWorktree({ repoRoot: root, taskId: 't2', title: 'x', recipe, exec: nodeExec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrepareError)
    expect((err as PrepareError).result.steps).toHaveLength(1)
  })

  it('times out a hanging step', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ setup: ['sleep 30'], timeoutSec: 1 })
    const err = await prepareWorktree({ repoRoot: root, taskId: 't3', title: 'x', recipe, exec: nodeExec }).catch((e: unknown) => e)
    expect((err as PrepareError).result.steps[0]?.output).toContain('таймаут 1 с')
  })

  it('reruns a red baseline on reuse until its cause is fixed (bl1)', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ baseline: 'test -f fixed.txt' })
    const now = () => new Date('2026-09-24T10:00:00Z')
    const first = await prepareWorktree({ repoRoot: root, taskId: 'b1', title: 'Red', recipe, exec: nodeExec, now })
    expect(first.baseline).toMatchObject({ ok: false })
    const head = (await nodeExec('git', ['-C', first.path, 'rev-parse', 'HEAD'])).stdout.trim()
    expect(first.record).toEqual({ commit: head, base: head, command: 'test -f fixed.txt', ok: false, at: '2026-09-24T10:00:00.000Z' })
    expect(await readWorktreeState(first.path)).toMatchObject({ baseline: { ok: false } })

    const second = await prepareWorktree({ repoRoot: root, taskId: 'b1', title: 'Red', recipe, exec: nodeExec, now })
    expect(second.reused).toBe(true)
    expect(second.baseline).toMatchObject({ ok: false })

    await writeFile(join(root, 'fixed.txt'), 'ok\n')
    await nodeExec('git', ['-C', root, 'add', 'fixed.txt'])
    await nodeExec('git', ['-C', root, 'commit', '-q', '-m', 'fix the cause'])
    const third = await prepareWorktree({ repoRoot: root, taskId: 'b1', title: 'Red', recipe, exec: nodeExec, now })
    expect(third.baseline).toMatchObject({ ok: true })
    expect(third.record).toMatchObject({ ok: true })
  })

  it('reruns a green baseline when the repository HEAD moved or the command changed', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ baseline: 'echo green' })
    const first = await prepareWorktree({ repoRoot: root, taskId: 'b2', title: 'Green', recipe, exec: nodeExec })
    expect(first.baseline).toMatchObject({ ok: true })

    // The worker's own commits do not move the base: the copy stays covered.
    await writeFile(join(first.path, 'work.txt'), 'work\n')
    await nodeExec('git', ['-C', first.path, 'add', 'work.txt'])
    await nodeExec('git', ['-C', first.path, 'commit', '-q', '-m', 'worker commit'])
    expect((await prepareWorktree({ repoRoot: root, taskId: 'b2', title: 'Green', recipe, exec: nodeExec })).baseline).toBeUndefined()

    const other = RecipeSchema.parse({ baseline: 'echo other' })
    expect((await prepareWorktree({ repoRoot: root, taskId: 'b2', title: 'Green', recipe: other, exec: nodeExec })).baseline).toMatchObject({ ok: true, step: 'echo other' })

    await writeFile(join(root, 'plan.md'), 'next\n')
    await nodeExec('git', ['-C', root, 'add', 'plan.md'])
    await nodeExec('git', ['-C', root, 'commit', '-q', '-m', 'move HEAD'])
    expect((await prepareWorktree({ repoRoot: root, taskId: 'b2', title: 'Green', recipe: other, exec: nodeExec })).baseline).toMatchObject({ ok: true })
  })

  it('treats a copy without a record as unknown: setup, then the baseline', async () => {
    const root = await makeRepo()
    const { path, branch } = worktreeLocation(root, 'b3', 'Old copy')
    // A copy made by an older version: no record at all.
    await nodeExec('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, path, 'HEAD'])
    const recipe = RecipeSchema.parse({ setup: ['echo ready > prepared.txt'], baseline: 'test -f prepared.txt' })
    const r = await prepareWorktree({ repoRoot: root, taskId: 'b3', title: 'Old copy', recipe, exec: nodeExec })
    expect(r.reused).toBe(true)
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([['echo ready > prepared.txt', true]])
    expect(r.baseline).toMatchObject({ ok: true })
  })

  it('finishes a setup that failed before running the baseline on reuse', async () => {
    const root = await makeRepo()
    const broken = RecipeSchema.parse({ setup: ['test -f setup-ok.txt || exit 3', 'echo ready > prepared.txt'], baseline: 'test -f prepared.txt' })
    const err = await prepareWorktree({ repoRoot: root, taskId: 'b4', title: 'Half', recipe: broken, exec: nodeExec }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PrepareError)
    // Reuse still stops at the failing setup instead of skipping it.
    expect(await prepareWorktree({ repoRoot: root, taskId: 'b4', title: 'Half', recipe: broken, exec: nodeExec }).catch((e: unknown) => e)).toBeInstanceOf(PrepareError)

    await writeFile(join((err as PrepareError).result.path, 'setup-ok.txt'), '')
    const r = await prepareWorktree({ repoRoot: root, taskId: 'b4', title: 'Half', recipe: broken, exec: nodeExec })
    expect(r.steps.map((s) => s.ok)).toEqual([true, true])
    expect(r.baseline).toMatchObject({ ok: true })
    const again = await prepareWorktree({ repoRoot: root, taskId: 'b4', title: 'Half', recipe: broken, exec: nodeExec })
    expect(again).toMatchObject({ steps: [], record: { ok: true } })
    expect(again.baseline).toBeUndefined()
  })

  it('reports a red baseline without throwing', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ baseline: 'exit 1' })
    const r = await prepareWorktree({ repoRoot: root, taskId: 't4', title: 'x', recipe, exec: nodeExec })
    expect(r.baseline?.ok).toBe(false)
    const list = await nodeExec('git', ['-C', root, 'worktree', 'list'])
    expect(list.stdout).toContain('orch-t4')
  })
})
