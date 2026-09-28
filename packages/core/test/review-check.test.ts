import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import type { Backends } from '../src/orchestration/backends.js'
import { finishCheck, takeCheck } from '../src/orchestration/check.js'
import { setPlanOrchestratorCheck, setRepositoryOrchestratorCheck } from '../src/orchestration/check-setting.js'
import type { TaskDetail } from '../src/orchestration/detail.js'
import { needsYou } from '../src/orchestration/needs-you.js'
import { buildRepoSnapshot } from '../src/orchestration/snapshot.js'
import { cleanToAccept, contractPaths, declaredDeviation, filesOutside, verdictOf } from '../src/orchestration/verdict.js'
import { reviewCheckOf } from '../src/plan/graph.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-25T12:00:00Z')

/** A finished run in review; the worker's final answer is `answer`; `setting` as in check.test.ts. */
async function setup(setting: boolean | 'chat' | undefined, answer = 'Result: received\nTests: 12 passed') {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 't1', title: 'T1', contract: 'contract.md' }), runs: [{ runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-25T11:00:00Z' }] })
    return p
  })
  if (setting === 'chat') {
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await writeFile(join(root, '.orchestration', 'chats.json'), JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: NOW.toISOString() } }))
  } else if (setting !== undefined) await setRepositoryOrchestratorCheck(root, setting)
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-b',
    events: async () => [{ ts: NOW.toISOString(), type: 'final', data: answer }],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  return { root, backends }
}

const task = async (root: string, backends: Backends) => (await buildRepoSnapshot(root, backends, NOW)).tasks.find((t) => t.id === 't1')!

describe('the orchestrator check where the person decides (vc1)', () => {
  it('says each state of a task in review, and why the check is off', async () => {
    const on = await setup(true)
    expect((await task(on.root, on.backends)).reviewCheck).toEqual({ state: 'pending', source: 'repository' })
    await takeCheck(on.root, 't1', NOW)
    expect((await task(on.root, on.backends)).reviewCheck).toEqual({ state: 'checking', source: 'repository' })
    await finishCheck(on.root, 't1', 'gates green', NOW)
    expect(await task(on.root, on.backends)).toMatchObject({ reviewCheck: { state: 'checked', source: 'repository' }, checkNote: 'gates green' })

    const chat = await setup('chat')
    expect((await task(chat.root, chat.backends)).reviewCheck).toEqual({ state: 'pending', source: 'chat' })

    // The newsroom-guard case: no chat, no setting — the check is off, and the reason is the missing chat.
    const none = await setup(undefined)
    expect((await task(none.root, none.backends)).reviewCheck).toEqual({ state: 'off', source: 'default' })
    const repoOff = await setup(false)
    expect((await task(repoOff.root, repoOff.backends)).reviewCheck).toEqual({ state: 'off', source: 'repository' })
    await setPlanOrchestratorCheck(repoOff.root, undefined, false)
    expect((await task(repoOff.root, repoOff.backends)).reviewCheck).toEqual({ state: 'off', source: 'plan' })
  })

  it('keeps a check the orchestrator ran with the setting off: checked, not «off»', async () => {
    const { root, backends } = await setup(undefined)
    expect((await task(root, backends)).reviewCheck).toEqual({ state: 'off', source: 'default' })
    await finishCheck(root, 't1', 'ran verify anyway', NOW)
    expect((await task(root, backends)).reviewCheck).toEqual({ state: 'checked', source: 'default' })
  })

  it('carries the check and the verdict into Needs you, and none for a decision or a task not in review', async () => {
    const { root, backends } = await setup(undefined, 'Result: blocked — need the staging password')
    await updatePlan(root, (p) => { p.tasks.push(newTask({ id: 'd1', title: 'Pick', kind: 'decision' })); return p })
    const snapshot = await buildRepoSnapshot(root, backends, NOW)
    const items = needsYou([snapshot])
    expect(items.find((i) => i.taskId === 't1')).toMatchObject({ kind: 'review', check: { state: 'off', source: 'default' }, verdict: { kind: 'negative', why: 'blocked' } })
    expect(items.find((i) => i.taskId === 'd1')?.check).toBeUndefined()
    expect(reviewCheckOf({ status: 'running', kind: 'implement' }, { enabled: false, source: 'default' })).toBeUndefined()
    expect(reviewCheckOf({ status: 'in_review', kind: 'root', check: 'checked' }, { enabled: true, source: 'chat' })).toBeUndefined()
  })

  it('records the contract\'s paths in the run evidence', async () => {
    const { root, backends } = await setup(true)
    await writeFile(join(root, 'contract.md'), '# Contract\n<paths>\n- src/api/\n</paths>\n')
    await buildRepoSnapshot(root, backends, NOW)
    const evidence = JSON.parse(await readFile(join(root, '.orchestration/runs/run_dsh-a/evidence.json'), 'utf8'))
    expect(evidence.paths).toEqual(['src/api/'])
  })

  it('puts the verdict with its reason on the card, read from the evidence', async () => {
    const { root, backends } = await setup(true, 'Result: received\nTests: 12 passed')
    // No files changed in the copy: the claim is disputed, and the card says why.
    expect((await task(root, backends)).verdict).toEqual({ kind: 'disputed', mismatch: 'no_files' })
  })
})

const detail = (patch: Partial<Omit<TaskDetail, 'verdict'>> = {}): Omit<TaskDetail, 'verdict'> => ({
  id: 't1', title: 'T1', kind: 'implement', status: 'in_review', deps: [], dependents: [],
  runs: [{ runId: 'run_1', agent: 'worker', startedAt: '2026-09-25T10:00:00Z', finishedAt: '2026-09-25T10:01:00Z', outcome: 'completed' }],
  notes: [], steers: [], events: [], changedFiles: ['src/a.ts'], report: { runId: 'run_1', text: 'Result: received\nTests: 12 passed', source: 'section', truncated: false },
  ...patch,
})
const withReport = (text: string) => detail({ report: { runId: 'run_1', text, source: 'section', truncated: false } })

describe('a declared deviation is a yellow fact, not a green result (vc1, B27)', () => {
  it('reads a deviation the worker declares, in a line or a section', () => {
    const inline = verdictOf(withReport('Result: received\nDeviation: kept the old endpoint, the new one needs a migration'))
    expect(inline).toMatchObject({ kind: 'result', caution: 'deviation' })
    expect(inline.facts.find((f) => f.code === 'deviation')).toMatchObject({ tone: 'warn', text: 'Deviation: kept the old endpoint, the new one needs a migration', sourceLine: 1 })
    const section = verdictOf(withReport('Результат: получен\n\n## Отклонения от контракта\n- тесты e2e не запускались: нет стенда'))
    expect(section).toMatchObject({ kind: 'result', caution: 'deviation' })
    expect(section.facts.find((f) => f.code === 'deviation')?.text).toBe('Отклонения от контракта: тесты e2e не запускались: нет стенда')
  })

  it('does not read «none», a journal mention or a file path as a deviation', () => {
    for (const text of [
      'Result: received\nDeviations: none',
      'Результат: получен\nОтклонений от контракта нет.',
      'Result: received\n## Deviations\nNone.',
      'Результат: получен\n## Отклонения\nНет',
      'Result: received\nNo deviations from the contract.',
      'Результат: получен\nЖурнал отклонений: docs/tmp/2026.09.24_vc1-verdict-check_deviations.md',
      'Result: received\nJournal at docs/tmp/2026.09.24_vc1_deviations.md',
    ]) {
      expect(declaredDeviation(text), text).toBeUndefined()
      expect(verdictOf(withReport(text)).caution, text).toBeUndefined()
    }
  })

  it('keeps a caution out of a clean batch acceptance', () => {
    expect(cleanToAccept({ kind: 'implement' }, { kind: 'result' })).toBe(true)
    expect(cleanToAccept({ kind: 'implement' }, { kind: 'result', caution: 'deviation' })).toBe(false)
  })

  it('lists changed files outside the paths the contract names', () => {
    const contract = '# C\n<paths>\n- packages/core/src/\n- docs/*.md\n- `scripts/**/*.mjs`\n</paths>\n'
    expect(contractPaths(contract)).toEqual(['packages/core/src/', 'docs/*.md', 'scripts/**/*.mjs'])
    expect(filesOutside(contractPaths(contract), ['packages/core/src/a.ts', 'docs/review.md', 'docs/en/cli.md', 'scripts/x/y.mjs', 'README.md'])).toEqual(['docs/en/cli.md', 'README.md'])
    const verdict = verdictOf(detail({ contract: { path: 'c.md', text: contract, truncated: false }, changedFiles: ['packages/core/src/a.ts', 'README.md'] }))
    expect(verdict.kind).toBe('result')
    expect(verdict.facts.find((f) => f.code === 'outside_paths')).toEqual({ code: 'outside_paths', count: 1, files: ['README.md'], tone: 'warn' })
    // No `<paths>` block: nothing is outside.
    expect(verdictOf(detail()).facts.some((f) => f.code === 'outside_paths')).toBe(false)
  })
})
