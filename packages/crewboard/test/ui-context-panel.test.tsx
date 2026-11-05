// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import type { EventOf, GoalEvent } from '../src/model/types.js'
import { ContextPanel } from '../src/ui/components/context-panel.js'
import { setLang } from '../src/ui/text.js'
import { node } from './ui-fixtures.js'

afterEach(() => { cleanup(); setLang('ru') })

const report = (seq: number, fields: Partial<EventOf<'reported'>> = {}): EventOf<'reported'> => ({
  type: 'reported', seq, ts: '2026-11-05T10:00:00Z', goalId: 'g', assignmentId: 'work', actor: 'worker', summary: 'Review complete', ...fields,
})
const panel = (events: GoalEvent[], id = 'work') => <ContextPanel node={node(id, 'waiting_answer')} chain={[]} events={events} onSelect={() => {}} sheet={false} open={false} onClose={() => {}} />

it('shows the report with expandable JSON and resets it for another node', async () => {
  setLang('en')
  const result = { verdict: 'approve', findings: [{ file: 'src/app.ts', line: 12, problem: '<script>alert(1)</script>' }] }
  const { rerender } = render(panel([report(1, { detail: 'Verified the affected flow.', result })]))
  const section = screen.getByRole('region', { name: 'Result' })
  expect(within(section).getByText('Review complete')).toBeTruthy()
  expect(within(section).getByText('Verified the affected flow.')).toBeTruthy()
  const toggle = within(section).getByText('JSON')
  const details = toggle.closest('details')!
  expect(details.open).toBe(false)
  await userEvent.click(toggle)
  expect(details.open).toBe(true)
  expect(section.querySelector('pre')?.textContent).toBe(JSON.stringify(result, null, 2))
  expect(section.querySelector('script')).toBeNull()
  rerender(panel([report(2, { assignmentId: 'next', result: {} })], 'next'))
  expect(screen.getByText('JSON').closest('details')!.open).toBe(false)
})

it('keeps the latest schema error visible and never shows an older successful result', () => {
  render(panel([
    report(1, { result: { verdict: 'approve' } }),
    report(2, { schemaError: 'Required property findings is missing' }),
    report(3, { assignmentId: 'another', result: { unrelated: true } }),
  ]))
  const section = screen.getByRole('region', { name: 'Итог' })
  expect(within(section).getByText('Ошибка схемы')).toBeTruthy()
  expect(within(section).getByText('Required property findings is missing')).toBeTruthy()
  expect(section.querySelector('details')).toBeNull()
})

it('shows legacy text reports and no result section before a report arrives', () => {
  const { rerender } = render(panel([report(1, { detail: 'Full legacy report' })]))
  expect(within(screen.getByRole('region', { name: 'Итог' })).getByText('Full legacy report')).toBeTruthy()
  expect(screen.queryByText('JSON')).toBeNull()
  rerender(panel([]))
  expect(screen.queryByRole('region', { name: 'Итог' })).toBeNull()
})
