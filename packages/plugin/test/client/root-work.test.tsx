// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { TaskPanel, primaryAction } from '../../src/client/panel/task-panel.js'
import { snapshotWaiting } from '../../src/client/review.js'
import { inboxItems } from '../../src/client/sidebar-model.js'
import { taskTone } from '../../src/client/styles.js'
import { nowPhrase, taskEssence } from '../../src/client/summary.js'
import { acceptableTasks } from '../../src/client/views/accept-batch.js'
import { TaskCard } from '../../src/client/views/board.js'
import { identityLabel, taskIdentity } from '../../src/client/provider.js'
import { workColumns } from '../../src/client/views/work.js'
import { setLang } from '../../src/client/i18n.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

// rt1: the orchestrator's own work and decisions it still prepares are its move, not the person's.
const inWork = makeTask({ id: 'i1', title: 'Stand', kind: 'root', status: 'running', byOrchestrator: true, activeSince: '2026-09-22T11:50:00Z' })
const rootReady = makeTask({ id: 'i2', title: 'Database', kind: 'root', status: 'ready' })
const preparing = makeTask({ id: 'h4', title: 'Pick', kind: 'decision', status: 'ready', needsHuman: true, preparing: true })
const prepared = makeTask({ id: 'h5', title: 'Pick again', kind: 'decision', status: 'ready', needsHuman: true, check: 'checked', checkNote: 'A or B; recommend A' })
const reported = makeTask({ id: 'i3', title: 'Done stand', kind: 'root', status: 'in_review', check: 'checked', checkNote: 'integrated' })

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

describe('lists: only reported root work and prepared decisions wait for the person', () => {
  it('keeps work in progress and decisions being prepared out of Needs you, the inbox and the counts', () => {
    const repo = makeRepo([inWork, rootReady, preparing, prepared, reported])
    expect(acceptableTasks(repo).map((t) => t.id)).toEqual(['h5', 'i3'])
    const columns = workColumns(repo)
    expect(columns.needsYou.map((t) => t.id)).toEqual(['h5', 'i3'])
    expect(columns.running.map((t) => t.id)).toEqual(['i1', 'h4'])
    expect(columns.ready.map((t) => t.id)).toEqual(['i2'])
    expect(inboxItems(makeSnapshot(repo)).map((item) => item.taskId).sort()).toEqual(['h5', 'i3'])
    expect(snapshotWaiting(makeSnapshot(repo))).toBe(2)
  })

  it('names the state in words on every card', () => {
    expect(taskTone(inWork)).toMatchObject({ label: 'in work by the orchestrator', glyph: '▣' })
    expect(taskTone(preparing)).toMatchObject({ label: 'being prepared by the orchestrator', glyph: '◆' })
    expect(taskEssence(inWork, new Date('2026-09-22T12:00:00Z'))).toBe('in work by the orchestrator · 10 min')
    expect(taskEssence(preparing)).toBe('being prepared by the orchestrator')
    expect(nowPhrase(preparing, []).text).toBe('Being prepared by the orchestrator.')
    expect(nowPhrase(rootReady, []).text).toContain('does this work itself')
  })
})

describe('task panel', () => {
  const mount = (task: TaskSnapshot, detail = makeDetail({ id: task.id, kind: task.kind, status: task.status })) => {
    const calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(detail) : jsonOk({})))
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    return calls
  }

  it('offers no button while the move is the orchestrator’s, and never a worker launch for root work', () => {
    for (const task of [inWork, rootReady, preparing]) expect(primaryAction(task)).toBe('orchestrator')
    mount(rootReady)
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull()
    expect(screen.getByText(/orch start i2/)).toBeTruthy()
    cleanup()
    mount(inWork)
    expect(screen.queryByRole('button', { name: 'Direction' })).toBeNull()
    expect(screen.getAllByText(/In work by the orchestrator/).length).toBeGreaterThan(0)
  })

  it('a prepared decision shows the orchestrator’s note above the buttons', () => {
    mount(prepared)
    expect(primaryAction(prepared)).toBe('decision')
    expect(screen.getByText('Prepared by the orchestrator')).toBeTruthy()
    expect(screen.getByText('A or B; recommend A')).toBeTruthy()
  })

  it('a reported root task shows the orchestrator’s report and its verdict, not «disputed»', async () => {
    const detail = makeDetail({ id: 'i3', kind: 'root', status: 'in_review', report: { runId: '', text: 'Result: received\n- [x] stand answers 200', source: 'orchestrator', truncated: false }, verdict: { kind: 'result', claim: 'result', facts: [] } })
    mount(reported, detail)
    expect(await screen.findByText("Orchestrator's report")).toBeTruthy()
    expect(screen.getByText('Checked by the orchestrator')).toBeTruthy()
    expect(screen.queryByText('Disputed')).toBeNull()
  })

  it('a decision still being prepared says so instead of «no checklist» or a verdict', async () => {
    mount(preparing, makeDetail({ id: 'h4', kind: 'decision', status: 'ready' }))
    expect(await screen.findByText('Being prepared by the orchestrator')).toBeTruthy()
    expect(screen.queryByText('The orchestrator left no checklist')).toBeNull()
    expect(screen.queryByText('Disputed')).toBeNull()
    expect(screen.queryByText('Result received')).toBeNull()
  })
})

describe('who does root work: the orchestrator, never «no worker assigned»', () => {
  const mount = (task: TaskSnapshot) => {
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, kind: task.kind, status: task.status })) : jsonOk({})))
    return render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  }

  it('the panel header, the Work card and the graph label say the orchestrator, in both languages', () => {
    for (const [lang, who, unset] of [['en', 'orchestrator', 'No worker assigned'], ['ru', 'оркестратор', 'воркер не задан']] as const) {
      setLang(lang)
      expect(identityLabel(taskIdentity(reported))).toBe(who)
      const { container } = mount(reported)
      expect(container.querySelector('.orc-panel__identity-name')?.textContent).toBe(who)
      expect(container.textContent).not.toContain(unset)
      cleanup()
      const card = render(<TaskCard task={rootReady} attention={[]} selected={false} density="overview" onSelect={() => {}} now={new Date('2026-09-22T12:00:00Z')} />)
      expect(card.container.querySelector('.orc-card__identity')?.textContent?.replace('··', '')).toBe(who)
      cleanup()
    }
  })

  it('a worker task keeps its worker line', () => {
    expect(identityLabel(taskIdentity(makeTask({ id: 'w1', kind: 'implement', worker: undefined })))).toBe('No worker assigned')
  })
})

describe('the orchestrator’s report is rendered, not shown as raw markdown', () => {
  const text = 'Result: received\n\n## Checks\n- [x] pnpm test passed\n- [ ] stand smoke\n\n## Evidence\n- commit `abc123`\n\n## Reproduce\n1. orch start i3'

  it('headings become section titles and task-list marks become ticks', async () => {
    const detail = makeDetail({ id: 'i3', kind: 'root', status: 'in_review', report: { runId: '', text, source: 'orchestrator', truncated: false }, verdict: { kind: 'result', claim: 'result', facts: [{ code: 'tests', tone: 'ok', sourceLine: 2 }] } })
    installFetch((url) => (url.includes('/api/task') ? jsonOk(detail) : jsonOk({})))
    const { container } = render(<TaskPanel repo={makeRepo([reported])} task={reported} attention={[]} onSelect={() => {}} density="overview" />)
    await screen.findByText("Orchestrator's report")
    const body = container.querySelector('.orc-report__body')!
    expect([...body.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Checks', 'Evidence', 'Reproduce'])
    expect(body.textContent).not.toMatch(/#|\[x\]|\[ \]/)
    expect(body.querySelector('code')?.textContent).toBe('abc123')
    // The verdict's link to the checks is named by what it is, not by the raw heading.
    expect(screen.getByRole('button', { name: /Checks in report/ })).toBeTruthy()
    expect(screen.queryByText(/## Checks/)).toBeNull()
  })
})
