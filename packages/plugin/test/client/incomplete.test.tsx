// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskPanel, primaryAction } from '../../src/client/panel/task-panel.js'
import { setLang } from '../../src/client/i18n.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

// bg1: a run that ended without handing its work in waits to be continued, not accepted or started over.
const unfinished = makeTask({ id: 'u1', title: 'Stress checks', status: 'ready', lastOutcome: 'incomplete', incomplete: { reason: 'no_report', uncommitted: 3 }, runs: 1, lastRunId: 'run_claude-a' })

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

describe('an incomplete run in the task panel', () => {
  it('V-bg1/continue-button says why and continues it in one click', async () => {
    expect(primaryAction(unfinished)).toBe('continue')
    expect(primaryAction({ ...unfinished, lastOutcome: 'failed' })).toBe('run')
    const calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'u1', status: 'ready' })) : jsonOk({ runId: 'run_claude-b' })))
    render(<TaskPanel repo={makeRepo([unfinished])} task={unfinished} attention={[]} onSelect={() => {}} density="overview" />)
    expect(screen.getByText('The run ended without a report. Uncommitted files: 3.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/continue'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/continue'))).toMatchObject({ method: 'POST', body: { task: 'u1' } })
  })

  it('names a missing result line in Russian too', () => {
    setLang('ru')
    const task = { ...unfinished, incomplete: { reason: 'no_claim' as const, uncommitted: 1 } }
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'u1', status: 'ready' })) : jsonOk({})))
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    expect(screen.getByText('Запуск закончился без строки «Результат:». Не закоммичено файлов: 1.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Продолжить' })).toBeTruthy()
  })
})
