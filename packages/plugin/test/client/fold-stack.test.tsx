// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { decideFolds, foldGraph } from '../../src/client/fold.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { fanPosition } from '../../src/client/views/graph/graph-view.js'
import { laneBands, layoutFoldStack, layoutGraph } from '../../src/client/views/graph/layout.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'

const old = '2026-09-21T12:00:00Z'
const now = new Date('2026-09-22T12:00:00Z')
const lane = (name: string) => Array.from({ length: 6 }, (_, i) => makeTask({ id: `${name}-${i}`, lane: name, title: `Задача ${name} ${i}`, status: 'accepted', acceptedAt: old }))
const fixture = () => {
  const tasks = [...lane('1A'), ...lane('2A'), ...lane('3A'), ...Array.from({ length: 12 }, (_, i) => makeTask({ id: `q${i}`, lane: 'Работа', status: 'ready' }))]
  tasks[18] = { ...tasks[18]!, deps: ['1A-1', '1A-2', '2A-1'] }
  return makeRepo(tasks, [], { planId: 'stack-test' })
}
afterEach(() => { cleanup(); localStorage.clear() })

it('packs three consecutive folded lanes into one short band while retaining guest boxes', async () => {
  const source = fixture()
  const decision = decideFolds(source, {}, now)
  const graph = foldGraph(source, decision)
  const visible = graph.nodes.map((node) => node.task ?? makeTask({ id: node.id, lane: node.lane }))
  const compact = layoutFoldStack(visible, decision.folded)
  const oldBands = laneBands(await layoutGraph(source.tasks))
  expect(compact.bands[0]?.lanes).toEqual(['1A', '2A', '3A'])
  expect(compact.bands[0]?.height).toBeLessThan(oldBands.slice(0, 3).reduce((sum, band) => sum + band.height, 0))
  expect(compact.nodes.has('1A-1')).toBe(true)
  expect(compact.nodes.get('lane:1A')?.y).toBe(compact.nodes.get('lane:3A')?.y)
})

it('fans task cards on hover, closes on leave or Escape, and skips motion when reduced', async () => {
  setLang('ru')
  installMatchMedia(false)
  const user = userEvent.setup()
  const onSelect = vi.fn()
  const view = render(<GraphView repo={fixture()} selectedId={null} onSelect={onSelect} density="overview" />)
  const chip = await screen.findByRole('button', { name: 'Развернуть дорожку 1A' })
  await user.hover(chip)
  expect(await screen.findByRole('button', { name: /Выбрать задачу 1A-0/ })).toBeTruthy()
  expect(document.querySelector('.orc-gfan--motion')).toBeTruthy()
  await user.click(screen.getByRole('button', { name: /Выбрать задачу 1A-0/ }))
  expect(onSelect).toHaveBeenCalledWith('1A-0')
  await user.hover(chip)
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('button', { name: /Выбрать задачу 1A-0/ })).toBeNull())
  await user.hover(chip)
  await user.unhover(chip)
  await waitFor(() => expect(screen.queryByRole('button', { name: /Выбрать задачу 1A-0/ })).toBeNull())
  view.unmount()
  installMatchMedia(true)
  render(<GraphView repo={fixture()} selectedId={null} onSelect={onSelect} density="overview" />)
  await user.hover(await screen.findByRole('button', { name: 'Развернуть дорожку 1A' }))
  expect(await screen.findByRole('button', { name: /Выбрать задачу 1A-0/ })).toBeTruthy()
  expect(document.querySelector('.orc-gfan--motion')).toBeNull()
})

it('routes aggregated edges to a chip and places its fan away from live nodes', () => {
  const source = fixture()
  const decision = decideFolds(source, {}, now)
  const graph = foldGraph(source, decision)
  expect(graph.edges).toContainEqual(expect.objectContaining({ from: 'lane:1A', to: 'q0', count: 2 }))
  const visible = graph.nodes.map((node) => node.task ?? makeTask({ id: node.id, lane: node.lane }))
  const { nodes, bands } = layoutFoldStack(visible, decision.folded)
  const chip = nodes.get('lane:1A')!
  const fan = fanPosition(chip, 6, nodes, bands)
  for (const pos of nodes.values()) expect(fan.x + 210 <= pos.x || pos.x + 176 <= fan.x || fan.y + 216 <= pos.y || pos.y + 64 <= fan.y).toBe(true)
  const labelLeft = Math.min(...[...nodes.values()].map((pos) => pos.x)) - 12
  for (const band of bands.filter((item) => !item.folded && item.lane)) expect(fan.x + 210 <= labelLeft || labelLeft + 205 <= fan.x || fan.y + 216 <= band.top + 4 || band.top + 24 <= fan.y).toBe(true)
})
