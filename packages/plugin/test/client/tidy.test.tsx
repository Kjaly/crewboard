// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installFetch, installMatchMedia, jsonOk, makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())

const task = (id: string, lane: string, pos?: { x: number; y: number }) => makeTask({ id, lane, pos, title: `Узел ${id}`, status: 'accepted' })
const node = (id: string) => screen.getByRole('button', { name: new RegExp(`Узел ${id}`) }).closest('.orc-gnode') as HTMLElement
const graph = () => document.querySelector('.orc-graph') as HTMLElement
type PositionCall = { repo: string; planId: string; expectedRev: number; positions: Array<{ task: string; pos: { x: number; y: number } | null }> }
const saved = (calls: ReturnType<typeof installFetch>) => calls.filter((call) => call.url.endsWith('/pos')).map((call) => call.body as PositionCall)
const setup = () => { installMatchMedia(true); return installFetch(() => jsonOk(null)) }

it('«Навести порядок» снимает все ручные позиции и возвращает узлы на вычисленные места', async () => {
  setLang('ru')
  const calls = setup()
  render(<GraphView repo={makeRepo([task('a', 'А', { x: 900, y: 900 }), task('b', 'Б', { x: 1000, y: 1000 })])} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: 'Навести порядок' })
  fireEvent.click(screen.getByRole('button', { name: 'Навести порядок' }))
  await waitFor(() => expect(saved(calls)).toEqual([{ repo: '/repo', planId: 'main', expectedRev: 1, positions: [{ task: 'a', pos: null }, { task: 'b', pos: null }] }]))
  await waitFor(() => expect(node('a').style.transform).toContain('translate(0px,0px)'))
  expect(node('b').style.transform).not.toContain('1000px')
  expect(node('a')).toBeTruthy()
  expect(node('b')).toBeTruthy()
})

it('уборка одной дорожки не трогает позиции узлов других дорожек', async () => {
  setLang('ru')
  const calls = setup()
  render(<GraphView repo={makeRepo([task('a', 'А', { x: 900, y: 900 }), task('b', 'Б', { x: 1000, y: 1000 })])} selectedId={null} onSelect={() => {}} density="overview" />)
  const button = await screen.findByRole('button', { name: 'По местам: А' })
  fireEvent.click(button)
  await waitFor(() => expect(saved(calls)).toEqual([{ repo: '/repo', planId: 'main', expectedRev: 1, positions: [{ task: 'a', pos: null }] }]))
  await waitFor(() => expect(node('a').style.transform).not.toContain('900px'))
  expect(node('b').style.transform).toContain('1000px')
})

it('⌘Z отменяет перенос, ⇧⌘Z повторяет его, а смена плана очищает стек', async () => {
  const calls = setup()
  const first = makeRepo([task('a', 'А')], [], { planId: 'one' })
  const view = render(<GraphView repo={first} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Узел a/ })
  fireEvent.pointerDown(screen.getByRole('button', { name: /Узел a/ }), { button: 0, pointerId: 1, clientX: 20, clientY: 20 })
  fireEvent.pointerMove(graph(), { pointerId: 1, clientX: 80, clientY: 20 })
  fireEvent.pointerUp(graph(), { pointerId: 1, clientX: 80, clientY: 20 })
  await waitFor(() => expect(saved(calls).at(-1)?.positions[0]?.pos).toEqual({ x: 60, y: 0 }))
  view.rerender(<GraphView repo={makeRepo([task('a', 'А', { x: 60, y: 0 })], [], { planId: 'one' })} selectedId={null} onSelect={() => {}} density="overview" />)
  await new Promise((resolve) => setTimeout(resolve, 200))
  fireEvent.keyDown(document, { key: 'z', metaKey: true })
  await waitFor(() => expect(saved(calls).at(-1)?.positions[0]?.pos).toBeNull())
  fireEvent.keyDown(document, { key: 'Z', metaKey: true, shiftKey: true })
  await waitFor(() => expect(saved(calls).at(-1)?.positions[0]?.pos).toEqual({ x: 60, y: 0 }))
  view.rerender(<GraphView repo={makeRepo([task('a', 'А')], [], { planId: 'two' })} selectedId={null} onSelect={() => {}} density="overview" />)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const count = saved(calls).length
  fireEvent.keyDown(document, { key: 'z', metaKey: true })
  expect(saved(calls)).toHaveLength(count)
})

it('узел остаётся там, куда его отпустили, даже далеко от своей дорожки', async () => {
  const calls = setup()
  render(<GraphView repo={makeRepo([task('a', 'А'), task('b', 'Б')])} selectedId={null} onSelect={() => {}} density="overview" />)
  await screen.findByRole('button', { name: /Узел a/ })
  fireEvent.pointerDown(screen.getByRole('button', { name: /Узел a/ }), { button: 0, pointerId: 1, clientX: 20, clientY: 20 })
  fireEvent.pointerMove(graph(), { pointerId: 1, clientX: 20, clientY: 200 })
  fireEvent.pointerUp(graph(), { pointerId: 1, clientX: 20, clientY: 200 })
  await waitFor(() => expect(saved(calls).at(-1)?.positions[0]?.pos).toEqual({ x: 0, y: 180 }))
  expect(node('a').style.transform).not.toContain('translate(0px,0px)')
})
