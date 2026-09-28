// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestraSnapshot, PlanProgressRef, PlanProgressStage } from '../../src/shared/types.js'
import { NowView } from '../../src/client/views/now.js'
import { resetNowOrder } from '../../src/client/now.js'
import { makeRepo, makeSnapshot, makeTask } from './helpers.js'

const ref = (root: string, planId: string, taskId: string, stage: PlanProgressStage, extra: Partial<PlanProgressRef> = {}): PlanProgressRef => ({ root, planId, taskId, title: `title ${taskId}`, kind: 'implement', stage, ...extra })

const ROOT = '/repo/main'
const COPY = '/repo/.worktrees/feat'

function snapshot(): OrchestraSnapshot {
  const main = makeRepo([makeTask({ id: 'run' })], [], { root: ROOT, planId: 'main', family: { root: ROOT, name: 'app' } } as never)
  const copy = makeRepo([makeTask({ id: 'copy' })], [], { root: COPY, planId: 'main', family: { root: ROOT, name: 'app' } } as never)
  return {
    ...makeSnapshot(main, copy),
    now: {
      coverage: 'partial',
      unknown: [{ root: ROOT, planId: 'main' }],
      items: [
        ref(COPY, 'main', 'copy', 'checked', { humanReview: true }),
        ref(ROOT, 'main', 'run', 'worker', { worker: 'deepseek' }),
        ref(ROOT, 'main', 'alarm', 'alert', { alerts: ['worker_gone'] }),
      ],
    },
  }
}

beforeEach(() => resetNowOrder())
afterEach(() => cleanup())

describe('NowView', () => {
  it('separates needs-you, work in progress and work alerts, and shows unknown coverage', () => {
    render(<NowView snapshot={snapshot()} onOpenRow={vi.fn()} onClose={vi.fn()} />)
    const human = screen.getByLabelText('Needs you')
    expect(human.textContent).toContain('title copy')
    expect(human.textContent).toContain('human review required')
    const work = screen.getByLabelText('Work in progress')
    expect(work.textContent).toContain('title run')
    expect(work.textContent).not.toContain('title copy')
    const alerts = screen.getByLabelText('Work alerts')
    expect(alerts.textContent).toContain('Worker gone')
    expect(screen.getByText('Coverage').textContent).toBe('Coverage')
    expect(screen.getByRole('status').textContent).toContain('partial')
  })

  it('opens a task row, keeps the row one button, and carries no second project block', () => {
    const onOpenRow = vi.fn()
    render(<NowView snapshot={snapshot()} onOpenRow={onOpenRow} onClose={vi.fn()} />)
    // The whole row is the control: its accessible name states the move, and no standalone «Open»
    // text exists to wrap onto a second grid line.
    const row = screen.getByText('title run').closest('button')!
    expect(row.getAttribute('aria-label')).toBe('Open: title run')
    expect(screen.queryByText('Open')).toBeNull()
    fireEvent.click(screen.getByText('title run'))
    expect(onOpenRow).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'run', root: ROOT, planId: 'main' }))
    // The compact App-level project switcher is the one project picker; Now stays free of a second copy row.
    expect(document.querySelector('[data-project-switcher]')).toBeNull()
    expect(document.querySelector('.orc-now__copies')).toBeNull()
  })
})
