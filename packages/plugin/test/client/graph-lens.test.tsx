// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Attention, RepoSnapshot } from '../../src/shared/types.js'
import { type Camera, createCamera } from '../../src/client/views/graph/camera.js'
import { NODE_H, NODE_W } from '../../src/client/views/graph/layout.js'
import { GraphView } from '../../src/client/views/graph/index.js'
import { installMatchMedia, makeRepo, makeTask } from './helpers.js'
import { liveTask } from '../../src/client/views/graph/graph-view.js'
import { lensIds, lensTasks } from '../../src/client/lens.js'

beforeEach(() => setLang('ru'))

const alert = (taskId: string): Attention => ({ kind: 'stalled', severity: 'alert', taskId, runId: `run-${taskId}`, message: 'тишина 9 мин' })

// A chain across columns and one loose branch: matches land far enough apart for a real fit.
const repo = (attention: Attention[]): RepoSnapshot =>
  makeRepo(
    [
      makeTask({ id: 'a', title: 'Первая задача', status: 'accepted' }),
      makeTask({ id: 'b', title: 'Вторая', status: 'in_review', deps: ['a'] }),
      makeTask({ id: 'c', title: 'Третья', status: 'in_review', deps: ['b'] }),
      makeTask({ id: 'd', title: 'Четвёртая', status: 'blocked', deps: ['c'], blockedBy: ['c'] }),
      makeTask({ id: 'x', title: 'Отдельная ветка', status: 'blocked', deps: ['a'], blockedBy: ['a'] }),
    ],
    attention,
  )

/** Where the world camera sits: node layout positions are read from the rendered transforms. */
const posOf = (title: RegExp): { x: number; y: number } => {
  const el = screen.getByRole('button', { name: title }).closest('.orc-gnode') as HTMLElement
  const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
  if (!m) throw new Error(`no transform on ${el.className}`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

/** rAF does not run under jsdom — the camera is stepped by hand to the end of the spring. */
const settle = (camera: Camera) => {
  for (let i = 0; i < 900 && camera.step(1 / 60, false); i += 1) {}
}

const viewCenter = (camera: Camera) => {
  const v = camera.viewBox()
  return { x: (v.minX + v.maxX) / 2, y: (v.minY + v.maxY) / 2 }
}

const view = (lens: 'attention' | 'ready' | 'review' | null, camera: Camera, walk?: { id: string; seq: number }) => (
  <GraphView repo={repo([alert('c')])} selectedId={null} onSelect={() => {}} density="overview" lens={lens} camera={camera} walk={walk ?? null} />
)

afterEach(() => cleanup())

it('a lens with one match keeps it in view at the current zoom', async () => {
  installMatchMedia(false)
  const camera = createCamera()
  render(view('attention', camera))
  await screen.findByRole('button', { name: /^Третья/ })
  // The aim is handed to the camera in a frame callback, so under load it may not have started
  // when the test reaches here: settle and re-check instead of assuming the first pass is final.
  await waitFor(() => {
    settle(camera)
    const at = posOf(/^Третья/)
    const eye = viewCenter(camera)
    // Pan limits may prevent exact centering when the plan is smaller than the viewport.
    // The focused node must still lie within the visible half-extent on each axis.
    const box = camera.viewBox()
    expect(Math.abs(eye.x - (at.x + NODE_W / 2))).toBeLessThanOrEqual((box.maxX - box.minX) / 2)
    expect(Math.abs(eye.y - (at.y + NODE_H / 2))).toBeLessThanOrEqual((box.maxY - box.minY) / 2)
  })
  const pos = posOf(/^Третья/)
  const v = camera.viewBox()
  expect(pos.x + NODE_W / 2).toBeGreaterThanOrEqual(v.minX)
  expect(pos.x + NODE_W / 2).toBeLessThanOrEqual(v.maxX)
})

it('a lens with several matches fits them, never under the readable floor', async () => {
  installMatchMedia(false)
  const camera = createCamera()
  const deep = makeRepo(
    Array.from({ length: 8 }, (_, i) =>
      makeTask({ id: `t${i}`, title: `Шаг ${i}`, status: 'in_review', deps: i === 0 ? [] : [`t${i - 1}`] }),
    ),
    [alert('t0'), alert('t7')],
  )
  render(<GraphView repo={deep} selectedId={null} onSelect={() => {}} density="overview" lens="attention" camera={camera} />)
  await screen.findByRole('button', { name: /^Шаг 7/ })
  settle(camera)
  // Eight columns cannot fit the viewport at a readable scale — the floor wins, not «everything visible».
  expect(camera.scale).toBeGreaterThanOrEqual(11 / 12 - 1e-9)
  const v = camera.viewBox()
  const first = posOf(/^Шаг 0/)
  expect(v.minX).toBeLessThanOrEqual(first.x)
})

it('«n» walks to the next match: the camera centres it at the current zoom', async () => {
  installMatchMedia(false)
  const camera = createCamera()
  // A deep chain: the walked-to match sits far enough from the plan edge for exact centring.
  const deep = makeRepo(
    Array.from({ length: 8 }, (_, i) =>
      makeTask({ id: `t${i}`, title: `Шаг ${i}`, status: 'in_review', deps: i === 0 ? [] : [`t${i - 1}`] }),
    ),
    [alert('t0'), alert('t5')],
  )
  const props = { repo: deep, selectedId: null, onSelect: () => {}, density: 'overview' as const, camera }
  const { rerender } = render(<GraphView {...props} lens="attention" walk={null} />)
  await screen.findByRole('button', { name: /^Шаг 7/ })
  settle(camera)

  rerender(<GraphView {...props} lens="attention" walk={{ id: 't5', seq: 1 }} />)
  settle(camera)
  const pos = posOf(/^Шаг 5/)
  const centre = viewCenter(camera)
  expect(centre.x).toBeCloseTo(pos.x + NODE_W / 2, 0)
  expect(centre.y).toBeCloseTo(pos.y + NODE_H / 2, 0)
})

it('switching the lens off restores the pose the camera had before', async () => {
  installMatchMedia(false)
  const camera = createCamera()
  const { rerender } = render(view(null, camera))
  await screen.findByRole('button', { name: /^Третья/ })
  settle(camera)
  camera.panBy(-50, -40)
  settle(camera)
  const before = { ...viewCenter(camera), scale: camera.scale }

  rerender(view('attention', camera))
  settle(camera)
  const pos = posOf(/^Третья/)
  const during = viewCenter(camera)
  // The camera went to the match — within the edge slack the pan limits defend.
  expect(Math.abs(during.x - (pos.x + NODE_W / 2))).toBeLessThanOrEqual(140)
  expect(Math.abs(during.x - before.x)).toBeGreaterThan(1)

  rerender(view(null, camera))
  settle(camera)
  const after = viewCenter(camera)
  expect(after.x).toBeCloseTo(before.x, 0)
  expect(after.y).toBeCloseTo(before.y, 0)
  expect(camera.scale).toBeCloseTo(before.scale, 5)
})

describe('камера при открытии плана', () => {
  it('ведёт к живой задаче, а не остаётся на прежнем месте', () => {
    const tasks = [
      makeTask({ id: 'old', status: 'accepted', lane: '2A' }),
      makeTask({ id: 'hot', status: 'running', lane: '2K', lastRunId: 'run_2' }),
    ]
    expect(liveTask(tasks)).toBe('hot')
  })

  it('предпочитает идущую задачу ждущей приёмки и готовой', () => {
    const tasks = [
      makeTask({ id: 'ready', status: 'ready' }),
      makeTask({ id: 'review', status: 'in_review' }),
      makeTask({ id: 'run', status: 'running' }),
    ]
    expect(liveTask(tasks)).toBe('run')
  })

  it('без живых задач не выбирает ничего — план вписывается целиком', () => {
    expect(liveTask([makeTask({ id: 'a', status: 'accepted' })])).toBeUndefined()
  })
})

describe('линза «В работе»', () => {
  it('подсвечивает только идущие задачи', () => {
    const repo = makeRepo([makeTask({ id: 'a', status: 'running' }), makeTask({ id: 'b', status: 'ready' }), makeTask({ id: 'c', status: 'accepted' })])
    expect([...lensIds(repo, 'running')]).toEqual(['a'])
  })

  it('пустой план не даёт совпадений', () => {
    const repo = makeRepo([makeTask({ id: 'a', status: 'accepted' })])
    expect(lensTasks(repo, 'running')).toEqual([])
  })
})

describe('кнопка «следующая по линзе»', () => {
  it('не появляется в графе, когда ждёт приёмки одна задача', async () => {
    installMatchMedia(false)
    const repo = makeRepo([makeTask({ id: 'a', status: 'in_review' }), makeTask({ id: 'b', status: 'accepted' })])
    render(<GraphView repo={repo} selectedId={null} onSelect={() => {}} density="overview" lens="review" setLens={() => {}} lensStep={() => {}} />)
    await screen.findByRole('button', { name: /Приёмка/ })
    expect(screen.queryByRole('button', { name: 'Следующая по линзе' })).toBeNull()
  })
})
