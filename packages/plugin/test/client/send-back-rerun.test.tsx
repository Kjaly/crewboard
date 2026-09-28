// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { ChangesTab } from '../../src/client/panel/tabs.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { returnedRuns } from '../../src/client/panel/previous-runs.js'
import type { TaskDetail, TaskSnapshot } from '../../src/shared/types.js'
import { type FetchCall, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

const RUN_1 = { runId: 'run_dsh-a', agent: 'dsh/deepseek-flash', startedAt: '2026-09-25T10:00:00Z', finishedAt: '2026-09-25T10:10:00Z', outcome: 'completed' as const }
const RUN_2 = { runId: 'run_dsh-b', agent: 'dsh/deepseek-flash', startedAt: '2026-09-25T11:00:00Z', finishedAt: '2026-09-25T11:10:00Z', outcome: 'completed' as const }
const SENT_BACK = { at: '2026-09-25T10:30:00Z', type: 'reject' as const, text: 'the empty list crashes', event: { kind: 'rejected' as const, reason: 'the empty list crashes' } }

let calls: FetchCall[] = []
function mount(task: TaskSnapshot, detail: TaskDetail) {
  calls = installFetch((url) => (url.includes('/api/trace') ? jsonOk({ start: RUN_1.startedAt, spans: [], turns: [], totals: {} }) : url.includes('/api/task') ? jsonOk(detail) : url.includes('/api/worktrees') ? jsonOk({ candidates: [], totalBytes: 0, policy: 'after' }) : jsonOk({ task: task.id, status: 'rejected', run: { runId: 'run_dsh-c', agent: 'dsh/deepseek-flash' } })))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
}
const rejects = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/reject'))

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

describe('Send back and rerun (wk1, B29)', () => {
  it('V-wk1/panel-rerun offers «Send back and rerun» with the same worker by default and says where the reason goes', async () => {
    const task = makeTask({ id: 't1', status: 'in_review', runs: 1, lastRunId: RUN_1.runId, worker: RUN_1.agent })
    mount(task, makeDetail({ id: 't1', status: 'in_review', runs: [RUN_1] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send back…' }))
    await waitFor(() => expect(screen.getByRole('option', { name: /the same worker/ })).toBeTruthy())
    expect(screen.getByText("The reason goes into the next run's prompt, after the contract.")).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for sending back' }), { target: { value: 'the empty list crashes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back and rerun' }))
    await waitFor(() => expect(rejects()).toHaveLength(1))
    expect(rejects()[0]?.body).toEqual({ repo: '/repo', task: 't1', reason: 'the empty list crashes', rerun: true })
  })

  it('plain Send back stays, without rerun; a decision offers no rerun', async () => {
    const task = makeTask({ id: 't1', status: 'in_review', runs: 1, lastRunId: RUN_1.runId })
    mount(task, makeDetail({ id: 't1', status: 'in_review', runs: [RUN_1] }))
    fireEvent.click(await screen.findByRole('button', { name: 'Send back…' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason for sending back' }), { target: { value: 'no' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send back' }))
    await waitFor(() => expect(rejects()).toHaveLength(1))
    expect(rejects()[0]?.body).toEqual({ repo: '/repo', task: 't1', reason: 'no' })
    cleanup()
    const decision = makeTask({ id: 'd1', kind: 'decision', status: 'in_review' })
    mount(decision, makeDetail({ id: 'd1', kind: 'decision', status: 'in_review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send back…' }))
    expect(screen.queryByRole('button', { name: 'Send back and rerun' })).toBeNull()
  })

  it('a task sent back without a rerun says the reason waits for the next run', () => {
    const task = makeTask({ id: 't1', status: 'ready', runs: 1, returned: true, lastDecision: { by: 'person', at: SENT_BACK.at, verdict: 'sent_back', reason: 'the empty list crashes' } })
    mount(task, makeDetail({ id: 't1', runs: [RUN_1], notes: [SENT_BACK] }))
    expect(screen.getByText("Sent back: “the empty list crashes”. The reason goes into the next run's prompt.")).toBeTruthy()
  })
})

describe('the returned run stays in view (wk1, B29)', () => {
  it('V-wk1/prev-run folds the first run as «Run 1 (returned)» with its reason, and opens its activity', async () => {
    expect(returnedRuns({ runs: [RUN_1, RUN_2], notes: [SENT_BACK] })).toMatchObject([{ number: 1, reason: 'the empty list crashes' }])
    expect(returnedRuns({ runs: [RUN_1], notes: [SENT_BACK] })).toEqual([])
    const task = makeTask({ id: 't1', status: 'in_review', runs: 2, lastRunId: RUN_2.runId })
    mount(task, makeDetail({ id: 't1', status: 'in_review', runs: [RUN_1, RUN_2], notes: [SENT_BACK] }))
    const summary = await screen.findByText('Run 1 (returned)')
    const block = summary.closest('details')
    expect(block?.open).toBe(false)
    expect(block?.textContent).toContain('Sent back: the empty list crashes')
    fireEvent.click(screen.getByRole('button', { name: "Show this run's activity" }))
    await waitFor(() => expect((screen.getByLabelText('Run') as HTMLSelectElement).value).toBe(RUN_1.runId))
  })

  it('renders in Russian', async () => {
    setLang('ru')
    const task = makeTask({ id: 't1', status: 'in_review', runs: 2, lastRunId: RUN_2.runId })
    mount(task, makeDetail({ id: 't1', status: 'in_review', runs: [RUN_1, RUN_2], notes: [SENT_BACK] }))
    expect(await screen.findByText('Запуск 1 (возвращён)')).toBeTruthy()
  })
})

describe('Changes marks each file (wk1)', () => {
  it('V-wk1/changes-marks shows A/M/D and +/− line counts', () => {
    const detail = makeDetail({
      id: 't1',
      changedFiles: ['new.ts', 'old.ts', 'src/a.ts'],
      files: [
        { path: 'new.ts', added: 12, deleted: 0, status: 'A' },
        { path: 'old.ts', added: 0, deleted: 30, status: 'D' },
        { path: 'src/a.ts', added: 3, deleted: 1, status: 'M' },
      ],
    })
    render(<ChangesTab detail={detail} root="/repo" />)
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent)
    expect(rows).toEqual(['Anew.ts+12 −0', 'Dold.ts+0 −30', 'Msrc/a.ts+3 −1'])
    expect(screen.getByTitle('Added').textContent).toBe('A')
  })
})
