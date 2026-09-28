// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { FeedTab } from '../../src/client/panel/tabs.js'
import { TaskPanel, primaryAction } from '../../src/client/panel/task-panel.js'
import { runFact } from '../../src/client/provider.js'
import { attentionText } from '../../src/client/summary.js'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { type FetchCall, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

type Attempt = NonNullable<TaskSnapshot['lastAttempt']>
const AT = '2026-09-25T10:30:00.000Z'
const failed = (reason: Attempt['reason'], action: Attempt['action'], extra: Partial<Attempt> = {}) =>
  makeTask({ id: 'f1', title: 'Failing task', status: 'ready', runs: 1, lastRunId: 'run_claude-a', lastOutcome: 'failed', lastAttempt: { outcome: 'failed', at: AT, reason, action, ...extra } })

let calls: FetchCall[] = []
function mount(task: TaskSnapshot, post: (url: string) => unknown = () => jsonOk({ runId: 'run_claude-b', agent: 'claude/opus' })) {
  calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id })) : url.includes('/api/worktrees') ? jsonOk({ candidates: [], totalBytes: 0, policy: 'after' }) : post(url)))
  render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
}
const runs = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/run'))

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

/**
 * V-fo1/last-attempt: per reason — the words, and the one move — in both languages. `ru`/`en` are the reason's
 * words, `move` the block's button.
 */
const CASES = [
  { reason: { code: 'rate_limited', resetsAt: '2026-09-25T15:00:00' }, action: 'retry', en: 'Usage limit reached — resets at 15:00', ru: 'Лимит исчерпан — сброс в 15:00', move: ['Try again', 'Повторить'] },
  { reason: { code: 'auth_expired', login: 'claude auth login' }, action: 'login', en: 'The worker is not logged in, or its login expired', ru: 'Воркер не залогинен или его вход истёк', move: ['Log in', 'Войти'] },
  { reason: { code: 'interrupted' }, action: 'retry', en: "The run's supervisor exited.", ru: 'Супервизор запуска исчез.', move: ['Try again', 'Повторить'] },
  { reason: { code: 'disk_full' }, action: 'retry', en: 'No space left on the disk', ru: 'На диске закончилось место', move: ['Try again', 'Повторить'] },
  { reason: { code: 'setup_failed', step: 'pnpm install' }, action: 'show_output', en: 'Preparing the copy failed: pnpm install', ru: 'Подготовка копии упала: pnpm install', move: ['Show output', 'Показать вывод'] },
  { reason: { code: 'baseline_red', step: 'pnpm test' }, action: 'show_output', en: 'The baseline run is red: pnpm test', ru: 'Базовый прогон красный: pnpm test', move: ['Show output', 'Показать вывод'] },
  { reason: { code: 'worker_error' }, action: 'retry', en: 'The worker failed', ru: 'Воркер упал', move: ['Try again', 'Повторить'] },
] as const

describe('the «Last attempt» block (fo1)', () => {
  it.each(CASES)('V-fo1/last-attempt $reason.code: says why and offers its move, in en and ru', ({ reason, action, en, ru, move }) => {
    const task = failed(reason as Attempt['reason'], action)
    expect(primaryAction(task)).toBe('attempt')
    mount(task)
    const block = screen.getByRole('region', { name: 'Last attempt' })
    expect(block.textContent).toContain('Failed')
    expect(block.textContent).toContain(en)
    expect(screen.getByRole('button', { name: move[0] })).toBeTruthy()
    // Start stays, as the secondary action.
    expect(screen.getByRole('button', { name: 'Start' }).className).toContain('orc-btn--ghost')
    cleanup()
    setLang('ru')
    mount(task)
    const ruBlock = screen.getByRole('region', { name: 'Последняя попытка' })
    expect(ruBlock.textContent).toContain('Упала')
    expect(ruBlock.textContent).toContain(ru)
    expect(screen.getByRole('button', { name: move[1] })).toBeTruthy()
  })

  it('Try again starts the task; Log in names the command; Show output shows the saved tail and the file', async () => {
    mount(failed({ code: 'worker_error' }, 'retry'))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(runs()).toHaveLength(1))
    cleanup()
    mount(failed({ code: 'auth_expired', login: 'codex login' }, 'login'))
    // bx1: both buttons first, the command on a line of its own after them.
    const row = screen.getByText('codex login').parentElement!
    expect([...row.children].map((el) => el.textContent)).toEqual(['Log in', 'Try again', 'codex login'])
    expect(screen.getByText('Log in in a terminal, then try again: codex login')).toBeTruthy()
    cleanup()
    mount(failed({ code: 'baseline_red', step: 'pnpm test' }, 'show_output', { text: 'FAIL src/a.test.ts', log: '/repo/.orchestration/output/f1/1-baseline.log' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show output' }))
    expect(screen.getByText('FAIL src/a.test.ts')).toBeTruthy()
    expect(screen.getByText('/repo/.orchestration/output/f1/1-baseline.log')).toBeTruthy()
  })

  it('an unfinished run offers Continue once, in the block', async () => {
    const task = makeTask({ id: 'u1', status: 'ready', runs: 1, lastOutcome: 'incomplete', incomplete: { reason: 'no_report', uncommitted: 2 }, lastAttempt: { outcome: 'incomplete', at: AT, action: 'continue' } })
    mount(task)
    expect(screen.getAllByRole('button', { name: 'Continue' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/continue'))).toBe(true))
  })
})

describe('a copy with uncommitted changes (fo1)', () => {
  it('V-fo1/dirty-question Start asks: continue with the changes, or reset the copy', async () => {
    let answered = 0
    mount(makeTask({ id: 'd1', status: 'ready', runs: 1 }), (url) => {
      if (!url.endsWith('/api/run')) return jsonOk(null)
      answered += 1
      return answered === 1 ? { ok: false, status: 409, json: async () => ({ ok: false, error: 'dirty_copy', message: 'x', vars: { id: 'd1', count: 2 } }), text: async () => '' } : jsonOk({ runId: 'run_dsh-2', agent: 'dsh' })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    await screen.findByRole('alertdialog')
    expect(screen.getByText('The copy holds 2 uncommitted change(s) from the previous run. How should the task start again?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reset the copy' }))
    await waitFor(() => expect(runs()).toHaveLength(2))
    expect(runs()[0]?.body).not.toHaveProperty('dirtyCopy')
    expect(runs()[1]?.body).toMatchObject({ task: 'd1', dirtyCopy: 'reset' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('asks in Russian too', async () => {
    setLang('ru')
    mount(makeTask({ id: 'd1', status: 'ready', runs: 1 }), (url) => (url.endsWith('/api/run') ? { ok: false, status: 409, json: async () => ({ ok: false, error: 'dirty_copy', vars: { count: 1 } }), text: async () => '' } : jsonOk(null)))
    fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
    await screen.findByRole('alertdialog')
    expect(screen.getByRole('button', { name: 'Продолжить с изменениями' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Сбросить копию' })).toBeTruthy()
  })
})

describe('quiet runs and core notes in the interface language (fo1, B33)', () => {
  it('V-fo1/card-stalled a running card says «quiet for N min»', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    const task = makeTask({ id: 's1', status: 'running', runs: 1, activeSince: '2026-09-25T11:30:00Z', stalledMin: 17 })
    expect(runFact(task, now)).toContain('quiet for 17 min')
    setLang('ru')
    expect(runFact(task, now)).toContain('тишина 17 мин')
    expect(runFact({ ...task, stalledMin: undefined }, now)).not.toContain('тишина')
  })

  it('a running card says «command running N min — text» (st2)', () => {
    const now = new Date('2026-09-25T12:00:00Z')
    const task = makeTask({ id: 's1', status: 'running', runs: 1, activeSince: '2026-09-25T11:30:00Z', runningMin: 7, command: 'pnpm test' })
    expect(runFact(task, now)).toContain('command running 7 min — pnpm test')
    setLang('ru')
    expect(runFact(task, now)).toContain('команда выполняется 7 мин — pnpm test')
  })

  it('an alarm from core reads from its code, not from its English fallback', () => {
    const stalled = { kind: 'stalled' as const, severity: 'alert' as const, taskId: 't', runId: 'r', message: 'May be stuck: quiet 16 min', idleMin: 16 }
    setLang('ru')
    expect(attentionText(stalled)).toBe('Возможно, зависла: тишина 16 мин')
    setLang('en')
    expect(attentionText({ ...stalled, kind: 'failed', reason: { code: 'auth_expired' }, detail: 'Error: 401' })).toBe('The worker is not logged in, or its login expired — Error: 401')
  })

  it('V-fo1/feed-note a runner note renders in the interface language', () => {
    const events = [{ ts: '2026-09-25T12:00:00Z', kind: 'steer' as const, text: 'stop requested', note: { code: 'stop_requested' as const } }]
    setLang('ru')
    render(<FeedTab detail={makeDetail({ id: 'a', events })} />)
    expect(screen.getByText('Запрошена остановка')).toBeTruthy()
  })
})
