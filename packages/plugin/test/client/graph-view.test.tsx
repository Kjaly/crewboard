// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Attention } from '../../src/shared/types.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))

afterEach(() => cleanup())

const stalled: Attention = { kind: 'stalled', severity: 'alert', taskId: 'stuck', runId: 'run_dsh-1', message: 'тишина 9 мин' }

const repo = makeRepo(
  [
    makeTask({ id: 'a', title: 'Первая задача', status: 'accepted' }),
    makeTask({ id: 'b', title: 'Вторая задача', status: 'running', worker: 'dsh', deps: ['a'] }),
    makeTask({ id: 'stuck', title: 'Завис воркер', status: 'running', worker: 'devin', deps: ['a'] }),
  ],
  [stalled],
)

const node = (name: RegExp) => screen.findByRole('button', { name })

it('shows a renamed registry worker on the next snapshot', async () => {
  installMatchMedia(false)
  const workers = [{ id: 'codex/gpt-6-astra', label: 'My review agent', provider: 'Codex' as const, billing: 'подписка' as const, main: true, usedIn: [] }]
  const renamed = makeRepo([makeTask({ id: 'rename', title: 'Review', worker: 'codex' })])
  const props = { repo: renamed, selectedId: null, onSelect: () => {}, density: 'overview' as const }
  const { rerender } = render(<GraphView {...props} workers={[{ ...workers[0], label: 'Codex GPT-6 Astra' }]} />)
  expect((await node(/Review/)).getAttribute('aria-label')).toContain('Codex GPT-6 Astra')
  rerender(<GraphView {...props} workers={workers} />)
  await waitFor(async () => expect((await node(/Review/)).getAttribute('aria-label')).toContain('My review agent'))
})

it('selects a task on click', async () => {
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" />)
  await user.click(await node(/Вторая задача/))
  expect(onSelect).toHaveBeenCalledWith('b')
})

it('walks the chain with the left and right arrows', async () => {
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  render(<GraphView repo={repo} selectedId="a" onSelect={onSelect} density="overview" />)
  ;(await node(/Первая задача/)).focus()
  await user.keyboard('{ArrowRight}')
  expect(onSelect).toHaveBeenCalledWith('b')

  cleanup()
  onSelect.mockClear()
  render(<GraphView repo={repo} selectedId="b" onSelect={onSelect} density="overview" />)
  ;(await node(/Вторая задача/)).focus()
  await user.keyboard('{ArrowLeft}')
  expect(onSelect).toHaveBeenCalledWith('a')
})

it('carries running status on the stripe and names the provider in the accessible node', async () => {
  setLang('ru')
  installMatchMedia(false)
  const { unmount } = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  const running = await node(/Вторая задача/)
  expect(running.getAttribute('aria-label')).toContain('идёт · DeepSeek V4 Flash')
  expect(running.querySelector('.orc-gnode__strip--running')).not.toBeNull()
  expect(running.querySelector('.orc-gnode__meta')?.textContent).toContain('DSDeepSeek V4 Flash')
  expect(running.querySelector('.orc-gnode__meta')?.textContent).not.toContain('идёт')
  unmount()

  installMatchMedia(true)
  const reduced = render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await node(/Вторая задача/)
  expect(reduced.container.querySelector('.orc-gnode__strip--running')).not.toBeNull()
})

it('marks a task that needs a human with a named «!»', async () => {
  setLang('ru')
  installMatchMedia(false)
  render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" />)
  await node(/Завис воркер/)
  expect(screen.getByLabelText('требует внимания')).toBeTruthy()
  expect(screen.getByLabelText('требует внимания').textContent).toBe('!')
})

it('клик по пустому месту снимает выделение', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const { container } = render(<GraphView repo={makeRepo([makeTask({ id: 'a', status: 'ready' })])} selectedId="a" onSelect={onSelect} density="overview" />)
  await screen.findByText(/Первая|a/)
  await user.click(container.querySelector('.orc-graph') as HTMLElement)
  expect(onSelect).toHaveBeenCalledWith(null)
})
