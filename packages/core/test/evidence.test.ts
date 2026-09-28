import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import { getTaskDetail } from '../src/orchestration/detail.js'
import { acceptTask } from '../src/orchestration/review.js'
import { syncPlan } from '../src/orchestration/sync.js'
import type { Backends } from '../src/orchestration/backends.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { readEvidence } from '../src/runs/evidence.js'

const NOW = new Date('2026-09-23T10:00:00Z')

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orch-evidence-'))
  await nodeExec('git', ['-C', root, 'init'])
  await writeFile(join(root, 'contract.md'), '<checks>\n- pnpm test\n- pnpm lint\n</checks>')
  await writeFile(join(root, 'file.txt'), 'before\n')
  await nodeExec('git', ['-C', root, 'add', '.'])
  await nodeExec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'])
  await writeFile(join(root, 'file.txt'), 'after\nextra\n')
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'a', title: 'A', contract: 'contract.md' }), worktree: { path: root, branch: 'main' }, runs: [{ runId: 'run_test-a', agent: 'dsh', model: 'deepseek-flash', contractPath: 'contract.md', startedAt: '2026-09-23T09:00:00Z' }] })
    return p
  })
  return root
}

function backend(answer?: string, unreadable = false): Backends {
  const run: RunBackend = {
    id: 'dsh', launch: async () => 'run_test-a',
    events: async () => { if (unreadable) throw new Error('events gone'); return answer ? [{ ts: NOW.toISOString(), type: 'final', data: answer }] : [] },
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {}, cancel: async () => {},
  }
  return { forAgent: async () => run }
}

describe('terminal run evidence', () => {
  it('projects legacy READY03 check claims read-only from the final answer, separately from receipts', async () => {
    const root = await fixture()
    await writeFile(join(root, 'contract.md'), '<checks>\n- pnpm --filter @crewboard/core typecheck\n- git diff --check\n</checks>\n')
    const answer = 'Результат: заблокирован — браузер недоступен.\n- Typecheck — **PASS**, exit 0.\n- `git diff --check` — **PASS**.\n- Worker browser — **NOT RUN**, EPERM'
    await syncPlan(root, backend(answer), NOW)
    const task = (await loadPlan(root)).tasks[0]!
    const evidencePath = join(root, task.runs[0]!.evidence!)
    const stored = JSON.parse(await readFile(evidencePath, 'utf8'))
    stored.checks = [
      { command: 'pnpm --filter @crewboard/core typecheck', state: 'unreported' },
      { command: 'git diff --check', state: 'not_run' },
    ]
    await writeFile(evidencePath, JSON.stringify(stored, null, 2))
    const immutableSnapshot = await readFile(evidencePath, 'utf8')

    const detail = await getTaskDetail(root, 'a', backend(answer), nodeExec)
    expect(detail.workerClaimProjection).toMatchObject({ version: 1, source: 'finalAnswer', checks: [
      { command: 'pnpm --filter @crewboard/core typecheck', state: 'run' },
      { command: 'git diff --check', state: 'run' },
    ], workerBrowserClaim: { state: 'not_run', line: '- Worker browser — **NOT RUN**, EPERM' } })
    expect(detail.evidence?.checks).toEqual(stored.checks)
    expect(detail.evidence?.crewboardChecks).toBeUndefined()
    expect(detail.verdict?.kind).toBe('negative')
    expect(await readFile(evidencePath, 'utf8')).toBe(immutableSnapshot)
  })

  it('writes once and serves the accepted facts without backend or worktree', async () => {
    const root = await fixture()
    const answer = 'Результат: получен\n## Отчёт\nВыполнил pnpm test; 2 tests passed.\nПроверку pnpm lint не запускал.\n'
    await syncPlan(root, backend(answer), NOW)
    const run = (await loadPlan(root)).tasks[0]!.runs[0]!
    expect(run.evidence).toBe('.orchestration/runs/run_test-a/evidence.json')
    const saved = await readEvidence(root, run.evidence)
    expect(saved).toMatchObject({ finalAnswer: answer, claimLine: 'Результат: получен', model: 'deepseek-flash', files: [{ path: 'file.txt', added: 2, deleted: 1 }], checks: [{ state: 'run' }, { state: 'not_run' }] })
    await syncPlan(root, backend('changed answer'), new Date(NOW.getTime() + 1000))
    expect((await readEvidence(root, run.evidence))?.finalAnswer).toBe(answer)
    await rm(join(root, 'file.txt'))
    const dead: Backends = { forAgent: async () => { throw new Error('backend must not be called') } }
    const detail = await getTaskDetail(root, 'a', dead, nodeExec)
    expect(detail.report?.text).toContain('Выполнил pnpm test')
    expect(detail.changedFiles).toEqual(['file.txt'])
    expect(detail.verdict?.facts.map((f) => f.code)).toContain('checks_not_run')
    await acceptTask(root, 'a', NOW, detail.verdict)
    expect((await loadPlan(root)).tasks[0]?.notes.at(-1)).toMatchObject({ type: 'accept', event: { kind: 'accepted', evidence: run.evidence }, verdict: { kind: 'result' } })
  })

  it('V-B12/finished-events a finished run with evidence still shows the events its backend kept', async () => {
    const root = await fixture()
    await syncPlan(root, backend('Результат: получен\nготово'), NOW)
    expect((await loadPlan(root)).tasks[0]?.runs[0]?.evidence).toBeDefined()
    const detail = await getTaskDetail(root, 'a', backend('Результат: получен\nготово'), nodeExec)
    expect(detail.events.map((e) => e.kind)).toEqual(['final'])
  })

  it('keeps old runs on the live path and separates unreported from unreadable', async () => {
    const old = await fixture()
    await updatePlan(old, (p) => { p.tasks[0]!.runs[0]!.finishedAt = NOW.toISOString(); p.tasks[0]!.runs[0]!.outcome = 'completed'; return p })
    expect((await getTaskDetail(old, 'a', backend('Результат: получен\n## Отчёт\nВыполнил pnpm test'), nodeExec)).report?.text).toContain('pnpm test')
    const root = await fixture()
    await syncPlan(root, backend('Результат: получен\n## Отчёт\nПроверки не упомянуты'), NOW)
    expect((await getTaskDetail(root, 'a', backend(), nodeExec)).evidence?.checks.map((c) => c.state)).toEqual(['unreported', 'unreported'])
    const unreadable = await fixture()
    await syncPlan(unreadable, backend(undefined, true), NOW)
    const detail = await getTaskDetail(unreadable, 'a', backend(), nodeExec)
    expect(detail.evidence?.checks.map((c) => c.state)).toEqual(['unreadable', 'unreadable'])
    expect(detail.verdict?.facts.some((f) => f.code === 'checks_unreadable')).toBe(true)
    expect(JSON.parse(await readFile(join(unreadable, '.orchestration/runs/run_test-a/evidence.json'), 'utf8')).finalAnswerState).toBe('unreadable')
  })
})
