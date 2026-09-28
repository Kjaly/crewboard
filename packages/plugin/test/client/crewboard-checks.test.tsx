// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import type { TaskDetail } from '../../src/shared/types.js'
import { type FetchCall, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

// ck1 (B30): «Run checks here» and the checks Crewboard ran, beside the worker's claim in the task panel.

const RUN = 'run_dsh-c1'
const task = makeTask({ id: 'c1', status: 'in_review', runs: 1, lastRunId: RUN, lastOutcome: 'completed' })
const evidence = (extra: Partial<NonNullable<TaskDetail['evidence']>> = {}): NonNullable<TaskDetail['evidence']> => ({
  version: 1, runId: RUN, worker: 'dsh', finalAnswerState: 'reported', files: [], filesState: 'reported', checks: [{ command: 'pnpm test', state: 'run' }], checksState: 'reported', capturedAt: '2026-09-25T09:30:00Z', ...extra,
})
const detail = (patch: Partial<TaskDetail> = {}) => makeDetail({
  id: 'c1', status: 'in_review', worktree: { path: '/tmp/copy', branch: 'orch/c1' },
  contract: { path: 'contracts/c1.md', text: '# C\n<checks>\n- pnpm lint\n- pnpm test\n</checks>\n', truncated: false },
  runs: [{ runId: RUN, agent: 'dsh', startedAt: '2026-09-25T09:00:00Z', finishedAt: '2026-09-25T09:30:00Z', outcome: 'completed' }],
  evidence: evidence(), ...patch,
})
const ran = {
  version: 1 as const, runId: RUN, by: 'person' as const, ranAt: '2026-09-25T10:00:00Z', worktree: '/tmp/copy', contractPath: 'contracts/c1.md', contractRevision: 'x', timeoutSec: 300,
  checks: [
    { command: 'pnpm lint', exitCode: 0, timedOut: false, durationMs: 900, tail: 'ok', output: '/r/.orchestration/output/c1/1-check-1.log', bytes: 2 },
    { command: 'pnpm test', exitCode: 1, timedOut: false, durationMs: 4000, tail: 'FAIL a.test.ts\n1 failed', output: '/r/.orchestration/output/c1/2-check-2.log', bytes: 40 },
  ],
}

let calls: FetchCall[] = []
function mount(first: TaskDetail, after: TaskDetail) {
  calls = installFetch((url) => url.includes('/api/run-checks') ? jsonOk(after) : url.includes('/api/task') ? jsonOk(first) : jsonOk({ candidates: [], totalBytes: 0, policy: 'after' }))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
}

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

it('runs the checks from the panel and shows what Crewboard saw: the count, the failure with its tail and file, the mismatch', async () => {
  const withRun = detail({
    evidence: evidence({ crewboardChecks: ran }),
    verdict: { kind: 'result', claim: 'result', facts: [
      { code: 'checks_run', count: 1, tone: 'ok' },
      { code: 'crewboard_checks', count: 1, total: 2, commands: ['pnpm test'], tone: 'warn' },
      { code: 'checks_mismatch', count: 1, commands: ['pnpm test'], tone: 'bad' },
    ] },
  })
  mount(detail(), withRun)
  expect(await screen.findByText("Crewboard has not run the contract's checks for this run.")).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Run checks here' }))
  await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/run-checks'))).toBe(true))
  expect(calls.find((c) => c.url.endsWith('/api/run-checks'))?.body).toMatchObject({ task: 'c1' })
  expect(await screen.findByText('Checks run by Crewboard: 1/2 passed')).toBeTruthy()
  expect(screen.getByText('Mismatch: the worker claims a result, Crewboard saw a check fail').className).toContain('orc-verdict__fact--bad')
  expect(screen.getByText('1/2 passed')).toBeTruthy()
  expect(screen.getByText(/FAIL a\.test\.ts/)).toBeTruthy()
  expect(screen.getByText('Full output: /r/.orchestration/output/c1/2-check-2.log')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Run checks again' })).toBeTruthy()
})

it('a contract without checks says so instead of the button', async () => {
  mount(detail({ contract: { path: 'contracts/c1.md', text: '# C\n', truncated: false } }), detail())
  expect(await screen.findByText('The contract has no <checks> block: there is nothing for Crewboard to run.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Run checks here' })).toBeNull()
})

it('keeps passing check details closed while leaving the result visible', async () => {
  const passed = { ...ran, checks: ran.checks.map((check) => ({ ...check, exitCode: 0, tail: 'ok' })) }
  const complete = detail({ evidence: evidence({ crewboardChecks: passed }) })
  mount(complete, complete)
  const result = await screen.findByText('2/2 passed')
  const details = result.closest('details')
  expect(details?.open).toBe(false)
  fireEvent.click(result.closest('summary')!)
  expect(details?.open).toBe(true)
  expect(screen.getByRole('button', { name: 'Run checks again' })).toBeTruthy()
})

it('says it in Russian too', async () => {
  setLang('ru')
  mount(detail(), detail())
  expect(await screen.findByRole('button', { name: 'Запустить проверки здесь' })).toBeTruthy()
})

it('leaves contract checks to the orchestrator while its check is in progress', async () => {
  const checkingTask = { ...task, check: 'checking' as const, reviewCheck: { state: 'checking' as const, source: 'chat' as const } }
  installFetch((url) => url.includes('/api/task') ? jsonOk(detail()) : jsonOk({ candidates: [], totalBytes: 0, policy: 'after' }))
  render(<TaskPanel repo={makeRepo([checkingTask])} task={checkingTask} attention={[]} onSelect={() => {}} density="overview" />)
  expect(await screen.findByText('The orchestrator is checking')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Run checks here' })).toBeNull()
})
