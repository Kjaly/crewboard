import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchInput, RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { LaunchError, WORKER_RULES, workerPromptText, launchTask } from '../src/orchestration/launch.js'
import { relaunchTask } from '../src/orchestration/relaunch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { saveOutput, tailLines } from '../src/worktree/output.js'
import { prepareWorktree } from '../src/worktree/prepare.js'
import { readWorktreeState } from '../src/worktree/state.js'
import { RecipeSchema } from '../src/worktree/recipe.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-24T12:00:00Z')
const CONTRACT = '# Contract\nDo the thing.\n'

async function setup(recipe?: object) {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), CONTRACT)
  await initPlan(root, 'g', NOW)
  if (recipe) await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify(recipe))
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 't1', title: 'T1', contract: 'contract.md' }))
    return p
  })
  const launches: LaunchInput[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async (input) => {
      launches.push(input)
      return `run_dsh-${launches.length}`
    },
    events: async () => [{ ts: '2026-09-24T12:05:00Z', type: 'answer_delta', data: 'Half done.' }],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home: root, now: () => NOW, agent: 'dsh', caller: 'person' as const }
  return { root, base, launches }
}

describe('worker prompt order (tk1)', () => {
  it('an explicit orchestrator commit owner overrides the default worker commit rule', () => {
    const prompt = workerPromptText('<commit_owner>orchestrator</commit_owner>\n# Task\nDo the thing.')
    expect(prompt).toContain('The orchestrator checks and commits them')
    expect(prompt).not.toContain('Commit your work on the task branch')
    expect(workerPromptText(CONTRACT)).toContain('Commit your work on the task branch')
  })
  it('a launch starts with the rules block, then the contract, and nothing per run', async () => {
    const { base, launches } = await setup()
    await launchTask({ ...base, taskId: 't1' })
    expect(await readFile(launches[0]?.promptFile ?? '', 'utf8')).toBe(`${WORKER_RULES}\n${CONTRACT}`)
  })

  it('a relaunch keeps the same order: rules, contract, then the previous run, the step and the note', async () => {
    const { root, base, launches } = await setup()
    await launchTask({ ...base, taskId: 't1' })
    await updatePlan(root, (p) => {
      const run = p.tasks[0]?.runs[0]
      if (run) Object.assign(run, { finishedAt: NOW.toISOString(), outcome: 'completed' })
      p.tasks[0]!.status = 'in_review'
      return p
    })
    await relaunchTask({ ...base, taskId: 't1', note: 'fix it', fromStep: 'pnpm test' })
    const prompt = await readFile(launches[1]?.promptFile ?? '', 'utf8')
    // The steady part is byte-identical to the first run's prompt: a prompt cache matches it whole.
    expect(prompt.startsWith(`${WORKER_RULES}\n${CONTRACT}\n<previous_run>\n`)).toBe(true)
    const at = (text: string) => prompt.indexOf(text)
    expect(at('Прошлый запуск: dsh')).toBeGreaterThan(at(CONTRACT))
    expect(at('Продолжи с шага: pnpm test')).toBeGreaterThan(at('Прошлый запуск: dsh'))
    expect(at('Указание человека: fix it')).toBeGreaterThan(at('Продолжи с шага'))
    expect(prompt.trimEnd().endsWith('</previous_run>')).toBe(true)
    // No run id or date ahead of the contract.
    expect(prompt.slice(0, at(CONTRACT))).toBe(`${WORKER_RULES}\n`)
    expect(WORKER_RULES).not.toMatch(/run_|\d{4}-\d{2}-\d{2}/)
  })

  it('the rules ask for long check output in a file', () => {
    expect(WORKER_RULES).toContain('Send long check output to a file and read back only the failing part or the tail.')
  })
})

describe('command output goes to a file (tk1)', () => {
  it('a red baseline with long output refuses with the path, the size and a tail of at most 20 lines; the file holds all of it', async () => {
    const { root, base, launches } = await setup({ baseline: 'seq 1 500; echo; echo; exit 1' })
    const err = await launchTask({ ...base, taskId: 't1' }).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(LaunchError)
    const refusal = err as LaunchError
    expect(refusal).toMatchObject({ code: 'baseline', output: { path: expect.stringContaining(join(root, '.orchestration/output/t1/')), bytes: expect.any(Number) } })
    const path = refusal.output?.path ?? ''
    const full = await readFile(path, 'utf8')
    expect(full.trimEnd().split('\n')).toEqual(Array.from({ length: 500 }, (_, i) => String(i + 1)))
    expect(refusal.output?.bytes).toBe(Buffer.byteLength(full))
    expect(refusal.message).toContain(`Full output (${(Buffer.byteLength(full) / 1024).toFixed(1)} KB): ${path}`)
    const tail = refusal.message.split('Last lines:\n')[1] ?? ''
    expect(tail.split('\n')).toEqual(Array.from({ length: 20 }, (_, i) => String(481 + i)))
    expect(refusal.message).not.toMatch(/^1$/m)
    expect(launches).toEqual([])
    // The copy's baseline record names the file, so the task panel and `worktree list` can show it.
    const wt = (await loadPlan(root)).tasks[0]?.worktree
    expect((await readWorktreeState(wt?.path ?? ''))?.baseline).toMatchObject({ ok: false, log: path })
  })

  it('a failed recipe step keeps its output in a file and its tail on the step', async () => {
    const root = await makeRepo()
    const recipe = RecipeSchema.parse({ setup: ['seq 1 100; exit 3'] })
    const err = await prepareWorktree({ repoRoot: root, taskId: 'p1', title: 'x', recipe, exec: nodeExec, now: () => NOW }).then(() => undefined, (e: { result: { steps: Array<{ output: string; log?: { path: string } }> } }) => e)
    const step = err?.result.steps.at(-1)
    expect(step?.output.split('\n')).toHaveLength(20)
    expect((await readFile(step?.log?.path ?? '', 'utf8')).trimEnd().split('\n')).toHaveLength(100)
  })

  it('a relaunch whose refresh leaves the copy mid-merge stops before the baseline and the worker, naming the copy (rf2)', async () => {
    const { root, base, launches } = await setup({ baseline: 'touch baseline-ran' })
    await launchTask({ ...base, taskId: 't1' })
    const path = (await loadPlan(root)).tasks[0]?.worktree?.path ?? ''
    await rm(join(path, 'baseline-ran'))
    await writeFile(join(path, 'README.txt'), 'worker\n')
    await nodeExec('git', ['-C', path, 'commit', '-q', '-am', 'worker'])
    await writeFile(join(root, 'README.txt'), 'main\n')
    await nodeExec('git', ['-C', root, 'commit', '-q', '-am', 'main'])
    await updatePlan(root, (p) => {
      const run = p.tasks[0]?.runs[0]
      if (run) Object.assign(run, { finishedAt: NOW.toISOString(), outcome: 'completed' })
      p.tasks[0]!.status = 'in_review'
      return p
    })
    const refusingAbort: typeof nodeExec = async (cmd, args, opts) =>
      cmd === 'git' && args.includes('--abort') ? { code: 128, stdout: '', stderr: 'fatal: index.lock exists\n', timedOut: false } : nodeExec(cmd, args, opts)
    const err = await relaunchTask({ ...base, exec: refusingAbort, taskId: 't1', note: 'again', lang: 'en' }).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(LaunchError)
    const refusal = err as LaunchError
    expect(refusal.code).toBe('prepare')
    expect(refusal.message).toContain(`Worktree preparation failed: Merging`)
    expect(refusal.message).toContain(`git -C ${path} merge --abort`)
    expect(refusal.output?.path).toMatch(/-refresh\.log$/)
    expect(launches).toHaveLength(1)
    await expect(readFile(join(path, 'baseline-ran'))).rejects.toThrow()
  })

  it('a tail leaves out a runner crash dump: stack frames, the code frame and vitest\'s Serialized Error (rf2)', () => {
    const dump = ['error TS1185: Merge conflict marker encountered.', '', '', '⎯⎯ Unhandled Error ⎯⎯', 'Error: Command failed: tsc', ' ❯ execFileSync node:child_process:961:15', '     15|   execFileSync(x)', '       |   ^', '    at wrappedFn (node:internal/errors:539:14)', '⎯⎯⎯⎯⎯⎯', 'Serialized Error: { status: 2 }', '', '']
    expect(tailLines(dump.join('\n'))).toBe(['error TS1185: Merge conflict marker encountered.', '', '⎯⎯ Unhandled Error ⎯⎯', 'Error: Command failed: tsc'].join('\n'))
    // Ordinary lines that only look alike stay.
    expect(tailLines('  at least one test failed\n  15 | 2 failed')).toBe('  at least one test failed\n  15 | 2 failed')
  })

  it('tails at a line boundary and keeps a bounded number of files per task', async () => {
    expect(tailLines('a\nb\nc\n\n\n', 2)).toBe('b\nc')
    expect(tailLines(`${'x'.repeat(5000)}\nshort`, 20)).toBe('short')
    const dir = join(await makeRepo(), '.orchestration/output/t9')
    await mkdir(dir, { recursive: true })
    for (let i = 0; i < 12; i++) await saveOutput(dir, 'baseline', `run ${i}\n`, new Date(NOW.getTime() + i))
    const files = (await readdir(dir)).sort()
    expect(files).toHaveLength(10)
    expect(await readFile(join(dir, files.at(-1) ?? ''), 'utf8')).toBe('run 11\n')
  })
})
