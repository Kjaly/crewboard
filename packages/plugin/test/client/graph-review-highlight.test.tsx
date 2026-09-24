// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { Lens } from '../../src/client/lens.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installFetch, installMatchMedia, jsonOk, makeRepo, makeTask } from './helpers.js'

const repo = makeRepo([
  makeTask({ id: 'a', title: 'Первая задача', status: 'accepted' }),
  makeTask({ id: 'rev', title: 'На приёмке', status: 'in_review', worker: 'dsh', runs: 1, lastRunId: 'run-1', deps: ['a'] }),
  makeTask({ id: 'pick', title: 'Решение', kind: 'decision', status: 'ready', needsHuman: true, deps: ['rev'], blockedBy: [] }),
  makeTask({ id: 'c', title: 'Дальше', status: 'blocked', deps: ['rev'], blockedBy: ['rev'] }),
  makeTask({ id: 'x', title: 'Отдельная ветка', status: 'blocked', deps: ['a'], blockedBy: ['a'] }),
])

// The node body is anchored: the «◐ принять» badge's name («Ждёт приёмки: …») would also match.
const node = (name: RegExp) => screen.findByRole('button', { name })

/** The chip drives the shared store in the app; the test stands in for it. */
function Harness() {
  const [lens, setLens] = useState<Lens | null>(null)
  return <GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" lens={lens} setLens={setLens} />
}

afterEach(() => cleanup())

it('marks review nodes with the amber class and an accept badge that selects and accepts', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const { container } = render(<GraphView repo={repo} selectedId={null} onSelect={onSelect} density="overview" />)
  await node(/^На приёмке/)
  // Both an in_review task and a ready human decision are «waiting for the human».
  const reviewNodes = container.querySelectorAll('.orc-gnode--review')
  expect(reviewNodes).toHaveLength(2)
  const badge = screen.getByRole('button', { name: 'Принять работу: На приёмке' })
  expect(badge.textContent).toBe('◐ Принять…')
  const calls = installFetch(() => jsonOk(null))
  await user.click(badge)
  // The badge does what it says: it selects the task and sends the same accept the panel sends.
  expect(onSelect).toHaveBeenCalledWith('rev')
  await waitFor(() => expect(calls.some((c) => c.url.includes('accept'))).toBe(true))
})

it('the «Приёмка» lens dims everything that is not waiting — and hides nothing', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const { container } = render(<Harness />)
  await node(/^На приёмке/)
  const chip = screen.getByRole('button', { name: /Приёмка · 2/ })
  expect(chip.getAttribute('aria-pressed')).toBe('false')
  await user.click(chip)
  expect(chip.getAttribute('aria-pressed')).toBe('true')
  // Линза dims — the filter it replaced used to delete the other nodes from the graph.
  expect(container.querySelectorAll('.orc-gnode')).toHaveLength(5)
  expect(container.querySelectorAll('.orc-gnode--dim')).toHaveLength(3)
  // Edges touching a waiting node stay lit for context; a→x joins nothing reviewable and dims.
  expect(container.querySelectorAll('.orc-gedge--dim')).toHaveLength(1)

  await user.click(chip)
  expect(container.querySelector('.orc-gnode--dim')).toBeNull()
})


it('кнопка «Принять…» на узле шлёт приёмку, а не просто выделяет задачу', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const calls = installFetch(() => jsonOk(null))
  const task = makeTask({ id: 'r1', title: 'Ждёт вас', status: 'in_review' })
  render(<GraphView repo={makeRepo([task])} selectedId="r1" onSelect={() => {}} density="detail" />)
  await user.click(await screen.findByRole('button', { name: /Принять работу/ }))
  await waitFor(() => expect(calls.some((c) => c.url.includes('accept'))).toBe(true))
})
