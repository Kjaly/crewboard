// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import type { Trajectory } from '../../src/shared/types.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { TraceScreen, type TraceTarget } from '../../src/client/panel/trace.js'
import { type FetchCall, ROOT, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

let calls: FetchCall[] = []
afterEach(() => cleanup())
beforeEach(() => {
  setLang('ru')
  calls = []
})

const T0 = Date.parse('2026-09-22T12:00:00Z')
const at = (sec: number) => T0 + sec * 1000

const trace: Trajectory = {
  start: T0,
  end: at(60),
  turns: [{ index: 1, start: T0, end: at(60), prompt: 'сделай', stopReason: 'success' }],
  spans: [
    { lane: 'model', label: 'модель', start: T0, end: at(10) },
    { lane: 'tools', label: 'pnpm test', start: at(10), end: at(40) },
  ],
  totals: { turns: 1, toolCalls: 1, toolMs: 30_000, modelMs: 10_000, durationMs: 60_000 },
}

const repo = makeRepo([makeTask({ id: 'a', status: 'running' })])
const target = (active: boolean): TraceTarget => ({
  taskId: 'a',
  taskTitle: 'Фундамент',
  run: { runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z', ...(active ? { active: true } : {}) },
})

function mountTrace(active: boolean, onSteerFrom = vi.fn()) {
  calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk({ runId: 'run_dsh-b' })))
  render(<TraceScreen repo={repo} target={target(active)} density="overview" onClose={() => {}} trace={trace} onSteerFrom={onSteerFrom} />)
  return onSteerFrom
}

const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))

it('relaunches a finished run from the selected step, with the previous worker by default', async () => {
  const user = userEvent.setup()
  mountTrace(false)
  await user.click(screen.getByRole('button', { name: /pnpm test/ }))
  await user.click(screen.getByRole('button', { name: 'Перезапустить с шага' }))
  await user.type(screen.getByRole('textbox', { name: 'Указание воркеру' }), 'почини два теста')
  expect((screen.getByRole('combobox', { name: 'Воркер' }) as HTMLSelectElement).value).toBe('dsh')
  await user.click(screen.getByRole('button', { name: 'Перезапустить' }))

  await waitFor(() => expect(posts('relaunch')).toHaveLength(1))
  const [call] = posts('relaunch')
  expect(call?.url).toBe('/crewboard/api/relaunch')
  expect(call?.headers['x-orchestra-client']).toBe('1')
  expect(call?.body).toEqual({ repo: ROOT, task: 'a', agent: 'dsh', fromStep: 'pnpm test', note: 'почини два теста' })
  expect(await screen.findByText(/run_dsh-b/)).toBeTruthy()
})

it('offers a correction, not a relaunch, while the run is still going', async () => {
  const user = userEvent.setup()
  const onSteerFrom = mountTrace(true)
  await user.click(screen.getByRole('button', { name: /pnpm test/ }))
  // The relaunch is not the main button of a live run: it is folded into «Ещё ▾».
  const folded = screen.getByRole('button', { name: 'Перезапустить с шага' }).closest('details')
  expect(folded?.open).toBe(false)
  await user.click(screen.getByRole('button', { name: 'Поправить отсюда…' }))
  expect(onSteerFrom).toHaveBeenCalledWith('С шага «pnpm test»: ')
  expect(posts('relaunch')).toHaveLength(0)

  // The relaunch is still reachable, one level down.
  await user.click(screen.getByText('Ещё ▾'))
  expect(folded?.open).toBe(true)
})

it('opens the correction field in the task panel already written up to the colon', async () => {
  calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'running' })) : jsonOk(null)))
  const task = makeTask({ id: 'a', status: 'running' })
  render(
    <TaskPanel
      repo={repo}
      task={task}
      attention={[]}
      onSelect={() => {}}
      density="overview"
      steerDraft={{ taskId: 'a', text: 'С шага «pnpm test»: ', seq: 1 }}
    />,
  )
  const field = (await screen.findByRole('textbox', { name: 'Поправка воркеру' })) as HTMLTextAreaElement
  expect(field.value).toBe('С шага «pnpm test»: ')

  const user = userEvent.setup()
  await user.type(field, 'сначала тесты')
  await user.click(screen.getByRole('button', { name: 'Отправить' }))
  await waitFor(() => expect(posts('steer')).toHaveLength(1))
  expect(posts('steer')[0]?.body).toEqual({ repo: ROOT, task: 'a', message: 'С шага «pnpm test»: сначала тесты' })
})

it('does not jump between problems while the human types into the inspector', async () => {
  const user = userEvent.setup()
  mountTrace(false)
  await user.click(screen.getByRole('button', { name: /pnpm test/ }))
  await user.click(screen.getByRole('button', { name: 'Перезапустить с шага' }))
  await user.type(screen.getByRole('textbox', { name: 'Указание воркеру' }), 'jk шаги')
  expect((screen.getByRole('textbox', { name: 'Указание воркеру' }) as HTMLTextAreaElement).value).toBe('jk шаги')
})
