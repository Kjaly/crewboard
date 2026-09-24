// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Trajectory } from '../../src/shared/types.js'
import { TraceScreen, type TraceTarget, spanKind, toEntities, toSteps } from '../../src/client/panel/trace.js'
import { makeRepo, makeTask } from './helpers.js'

afterEach(() => cleanup())
beforeEach(() => setLang('ru'))

const T0 = Date.parse('2026-09-22T12:00:00Z')
const at = (sec: number) => T0 + sec * 1000

const trace: Trajectory = {
  start: T0,
  end: at(60),
  turns: [{ index: 1, start: T0, end: at(60), prompt: 'сделай', stopReason: 'success' }],
  spans: [
    { lane: 'input', label: 'сделай', start: T0, end: T0 },
    { lane: 'model', label: 'модель', start: T0, end: at(10) },
    { lane: 'tools', label: 'pnpm test', start: at(10), end: at(40) },
    { lane: 'tools', label: 'Read app.tsx', start: at(40), end: at(45) },
    { lane: 'problem', label: 'bash failed', start: at(50), end: at(50) },
    { lane: 'problem', label: 'edit failed', start: at(50.5), end: at(50.5) },
  ],
  totals: { turns: 1, toolCalls: 2, toolMs: 35_000, modelMs: 10_000, durationMs: 60_000 },
}

const target: TraceTarget = {
  taskId: 'a',
  taskTitle: 'Фундамент',
  run: { runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-22T12:00:00Z' },
}

const repo = makeRepo([makeTask({ id: 'a' })])
const view = (onClose = vi.fn()) => {
  render(<TraceScreen repo={repo} target={target} density="overview" onClose={onClose} trace={trace} now={new Date(at(60))} />)
  return onClose
}
const inspector = () => within(screen.getByRole('complementary'))

it('colours a tool step by what it did, not by who did it', () => {
  expect([spanKind('Read app.tsx'), spanKind('pnpm test'), spanKind('normalize.ts'), spanKind('websearch')]).toEqual(['read', 'cmd', 'edit', 'tool'])
  expect(toSteps(trace).map((s) => s.kind)).toEqual(['input', 'model', 'cmd', 'read', 'problem', 'problem'])
})

it('collapses marks that would overlap on screen into one, keeping the count', () => {
  const entities = toEntities(toSteps(trace), trace.start, trace.end)
  expect(entities).toHaveLength(5)
  expect(entities.at(-1)?.steps).toHaveLength(2)
  expect(screen.queryByText('x')).toBeNull()
  view()
  expect(screen.getByRole('button', { name: /2 отметки/ })).toBeTruthy()
})

it('opens the inspector on a step, walks steps with ←/→ and closes with Esc', async () => {
  setLang('ru')
  const user = userEvent.setup()
  const onClose = view()
  expect(inspector().getByText(/Выберите шаг/)).toBeTruthy()

  await user.click(screen.getByRole('button', { name: /pnpm test/ }))
  expect(inspector().getByRole('heading', { name: 'pnpm test' })).toBeTruthy()
  expect(inspector().getByText(/команда · \+0:10 · 30 с/)).toBeTruthy()

  await user.keyboard('{ArrowRight}')
  expect(inspector().getByRole('heading', { name: 'Read app.tsx' })).toBeTruthy()
  await user.keyboard('{ArrowLeft}{ArrowLeft}')
  expect(inspector().getByRole('heading', { name: 'модель' })).toBeTruthy()

  await user.keyboard('{Escape}')
  expect(inspector().getByText(/Выберите шаг/)).toBeTruthy()
  expect(onClose).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalled()
})

it('jumps between problems with j and k', async () => {
  const user = userEvent.setup()
  view()
  await user.click(screen.getByRole('button', { name: /pnpm test/ }))
  await user.keyboard('j')
  expect(inspector().getByRole('heading', { name: '2 отметки рядом' })).toBeTruthy()
  expect(inspector().getByText('bash failed')).toBeTruthy()
  expect(inspector().getByText('edit failed')).toBeTruthy()
})

it('switches to the events view', async () => {
  const user = userEvent.setup()
  view()
  await user.click(screen.getByRole('radio', { name: 'События' }))
  const items = screen.getAllByRole('listitem')
  expect(items[0]?.textContent).toContain('сделай')
  expect(items.at(-1)?.textContent).toContain('edit failed')
})
