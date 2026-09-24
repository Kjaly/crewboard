// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import type { ReactNode } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../../src/client/api.js'
import { App } from '../../src/client/app.js'
import { orchestraStore, resetOrchestraStore } from '../../src/client/store.js'
import { formatRoute } from '../../src/client/route.js'
import { FakeEventSource, ROOT, installEventSource, installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))

const snapshot = makeSnapshot(
  makeRepo(
    [makeTask({ id: 'a', title: 'Первая задача' }), makeTask({ id: 'b', title: 'Вторая', status: 'running' })],
    [{ kind: 'stalled', severity: 'alert', taskId: 'b', runId: 'run-1', message: 'тишина 9 мин' }],
  ),
)

async function mount(extra?: ReactNode) {
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk(snapshot)))
  const rendered = render(
    <>
      <App />
      {extra}
    </>,
  )
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', snapshot)
  })
  return rendered
}

const density = () => ['Компактно', 'Подробно'].find((name) => screen.getByRole('radio', { name }).getAttribute('aria-checked') === 'true')

beforeEach(() => {
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

it('reloads the task and tab named in the hash', async () => {
  window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: '_', view: 'graph', task: 'a', tab: 'changes' }))
  orchestraStore.startRouting()
  await mount()
  expect(screen.getByRole('heading', { name: 'Первая задача' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: /Изменения/ }).getAttribute('aria-selected')).toBe('true')
  cleanup()
  resetOrchestraStore()
  orchestraStore.startRouting()
  await mount()
  expect(screen.getByRole('heading', { name: 'Первая задача' })).toBeTruthy()
  expect(screen.getByRole('tab', { name: /Изменения/ }).getAttribute('aria-selected')).toBe('true')
  window.history.replaceState(null, '', '/')
})

it('restores the lazy settings screen from the hash after reload', async () => {
  const workers = vi.spyOn(api, 'workers').mockResolvedValue({ ok: false, error: 'network' })
  window.history.replaceState(null, '', formatRoute({ repo: ROOT, plan: '_', view: 'settings' }))
  orchestraStore.startRouting()
  await mount()
  await waitFor(() => expect(document.querySelector('.orc-settings-screen')).toBeTruthy())
  cleanup()
  resetOrchestraStore()
  orchestraStore.startRouting()
  await mount()
  await waitFor(() => expect(document.querySelector('.orc-settings-screen')).toBeTruthy())
  window.history.replaceState(null, '', '/')
  workers.mockRestore()
})

it('toggles density with `d`, but not while typing', async () => {
  const user = userEvent.setup()
  await mount(<textarea aria-label="поле" />)
  expect(density()).toBe('Компактно')
  await user.keyboard('d')
  expect(density()).toBe('Подробно')
  await user.click(screen.getByRole('textbox', { name: 'поле' }))
  await user.keyboard('d')
  expect(density()).toBe('Подробно')
  expect((screen.getByRole('textbox', { name: 'поле' }) as HTMLTextAreaElement).value).toBe('d')
})

it('switches the view and remembers it for the repository', async () => {
  setLang('ru')
  const user = userEvent.setup()
  await mount()
  expect(screen.getByRole('radio', { name: 'Граф' }).getAttribute('aria-checked')).toBe('true')
  await user.click(screen.getByRole('radio', { name: 'Работа' }))
  expect(screen.getByRole('radio', { name: 'Работа' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByRole('region', { name: /^Можно запускать/ })).toBeTruthy()
  expect(localStorage.getItem(`crewboard:view:${ROOT}`)).toBe('work')

  cleanup()
  resetOrchestraStore()
  await mount()
  expect(screen.getByRole('radio', { name: 'Работа' }).getAttribute('aria-checked')).toBe('true')
})

it('updates the graph node and task panel when the next snapshot renames a worker', async () => {
  const user = userEvent.setup()
  await mount()
  const renamed = {
    ...snapshot,
    repos: [makeRepo([makeTask({ id: 'a', title: 'Первая задача', worker: 'codex' })])],
    workers: [{ id: 'codex/gpt-6-astra', label: 'My review agent', provider: 'Codex' as const, billing: 'подписка' as const, main: true, usedIn: [] }],
  }
  await act(async () => { FakeEventSource.last?.emit('snapshot', renamed) })
  const node = await screen.findByRole('button', { name: /Первая задача.*My review agent/ })
  await user.click(node)
  await waitFor(() => expect(screen.getAllByText('My review agent').length).toBeGreaterThan(1))
})

const chip = (name: RegExp) => screen.getByRole('button', { name })

it('the header chips are lenses: pressed, explained, mutually exclusive — and nothing disappears', async () => {
  const user = userEvent.setup()
  const { container } = await mount()
  await screen.findByRole('button', { name: /Первая задача/ })

  const attention = chip(/Требует внимания · 1/)
  expect(attention.getAttribute('title')).toContain('ничего не скрывая')
  await user.click(attention)
  expect(attention.getAttribute('aria-pressed')).toBe('true')
  // Линза dims instead of filtering: both nodes are still on the graph.
  expect(container.querySelectorAll('.orc-gnode')).toHaveLength(2)
  expect(container.querySelectorAll('.orc-gnode--dim')).toHaveLength(1)

  const ready = chip(/Готовы · 1/)
  await user.click(ready)
  expect(attention.getAttribute('aria-pressed')).toBe('false')
  expect(ready.getAttribute('aria-pressed')).toBe('true')
  expect(localStorage.getItem(`crewboard:lens:${ROOT}`)).toBe('ready')
})

it('`n` walks the lens matches and selects the task; Escape folds the lens first', async () => {
  const user = userEvent.setup()
  await mount()
  await user.click(chip(/Требует внимания/))
  await user.keyboard('n')
  expect(localStorage.getItem(`crewboard:task:${ROOT}`)).toBe('b')
  // One match needs no «следующая» button: the walk would land on the same task.
  expect(screen.queryByRole('button', { name: 'Следующая по линзе' })).toBeNull()

  await user.keyboard('{Escape}')
  expect(chip(/Требует внимания/).getAttribute('aria-pressed')).toBe('false')
  expect(localStorage.getItem(`crewboard:task:${ROOT}`)).toBe('b')
  await user.keyboard('{Escape}')
  expect(localStorage.getItem(`crewboard:task:${ROOT}`)).toBe('')
})


it('shows waiting once, omits zero lenses, and retains non-zero lenses', async () => {
  setLang('en')
  const current = makeRepo([makeTask({ id: 'w', status: 'in_review', needsHuman: true })])
  const other = makeRepo([makeTask({ id: 'x', status: 'in_review', needsHuman: true })], [], { root: '/ap-a' })
  const frame = makeSnapshot(current, other)
  installEventSource()
  installFetch(() => jsonOk(frame))
  render(<App />)
  await act(async () => { FakeEventSource.last?.emit('snapshot', frame) })
  const header = document.querySelector('.orc-top')!
  expect(header.textContent?.match(/Waiting for you · 1/g)).toHaveLength(1)
  expect(screen.getByRole('treeitem', { name: /^repo/ }).textContent).not.toContain('waiting')
  const elsewhere = [...document.querySelectorAll<HTMLElement>('.orc-ibrow')].find((row) => row.textContent?.includes('ap-a'))
  expect(elsewhere?.getAttribute('title')).toContain('awaiting review')
  expect(header.textContent).not.toContain('Needs attention')
  expect(header.textContent).not.toContain('Running')
  await act(async () => { FakeEventSource.last?.emit('snapshot', { ...frame, repos: [makeRepo([makeTask({ id: 'r', status: 'running' })], [{ kind: 'stalled', severity: 'alert', taskId: 'r', runId: 'run', message: 'stalled' }]), other] }) })
  expect(header.textContent).toContain('Needs attention · 1')
  expect(header.textContent).toContain('Running · 1')
  expect(screen.queryByRole('button', { name: 'Status' })).toBeNull()
  expect(screen.getByRole('button', { name: /Running · 1/ })).toBeTruthy()
  const refreshed = [...document.querySelectorAll<HTMLElement>('.orc-ibrow')].find((row) => row.textContent?.includes('ap-a'))
  await userEvent.setup().click(refreshed!)
  expect(orchestraStore.getState().repoRoot).toBe('/ap-a')
})

it('provides the same views through a narrow-container menu', async () => {
  setLang('en')
  const user = userEvent.setup()
  const { container } = await mount()
  const menu = screen.getByRole('combobox', { name: 'View', hidden: true })
  expect(menu.querySelectorAll('option')).toHaveLength(3)
  await user.selectOptions(menu, 'work')
  expect(screen.getByRole('radio', { name: 'Work' }).getAttribute('aria-checked')).toBe('true')
  expect(container.querySelector('.orc-main')).toBeTruthy()
  const styles = Array.from(document.querySelectorAll('style')).map((node) => node.textContent ?? '').join('')
  expect(styles).toContain('@container (max-width:1100px){.orc-top>.orc-seg{display:none}.orc-view-menu{display:block}}')
  expect(styles).toContain('@container (max-width:900px)')
  expect(styles).toContain('flex-wrap:nowrap')
})

// wp1: the header counts tasks whose assigned worker is outside the preset, next to the preset chip.
it('shows «outside preset» in the header when a task is assigned outside the preset', async () => {
  const outside = makeSnapshot(makeRepo([makeTask({ id: 'a', title: 'Первая задача', worker: 'devin', workerSource: 'person', outsidePreset: true }), makeTask({ id: 'b', title: 'Вторая' })]))
  installEventSource()
  installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk(outside)))
  render(<App />)
  await act(async () => {
    FakeEventSource.last?.emit('snapshot', outside)
  })
  expect(await screen.findByRole('button', { name: /Вне пресета · 1/ })).toBeTruthy()
})
