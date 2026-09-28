// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReviewCheck } from '@crewboard/core'
import type { OrchestraRepoSnapshot, RepoSnapshot, TaskSnapshot } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { GraphView } from '../../src/client/views/graph/graph-view.js'
import { WorkView } from '../../src/client/views/work.js'
import { type FetchCall, installFetch, installMatchMedia, jsonFail, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(() => cleanup())

// vc1: finished work in review, as the snapshot carries it — with the check state and its source.
const inReview = (reviewCheck: ReviewCheck, patch: Partial<TaskSnapshot> = {}) => makeTask({
  id: 'f2a', title: 'Guard the newsroom', status: 'in_review', runs: 1, lastRunId: 'run-f2a',
  ...(reviewCheck.state !== 'off' ? { check: reviewCheck.state } : {}), reviewCheck, ...patch,
})
/** The graph node's body; a waiting node also carries its accept badge, a second button with the title. */
const graphCard = async () => (await screen.findAllByRole('button', { name: /Guard the newsroom/ })).find((b) => b.classList.contains('orc-gnode__body'))!
const repoWith = (task: TaskSnapshot, patch: Partial<RepoSnapshot> = {}) => makeRepo([task], [], { planId: 'main', ...patch })

const STATES: Array<[ReviewCheck, string]> = [
  [{ state: 'pending', source: 'chat' }, "Waiting for the orchestrator's check"],
  [{ state: 'checking', source: 'chat' }, 'The orchestrator is checking'],
  [{ state: 'checked', source: 'default' }, 'Checked by the orchestrator'],
  [{ state: 'off', source: 'default' }, 'No orchestrator check — off for this plan (no orchestrator chat)'],
  [{ state: 'off', source: 'plan' }, 'No orchestrator check — turned off for this plan'],
  [{ state: 'off', source: 'repository' }, 'No orchestrator check — turned off for this repository'],
]

describe('the check state where the person decides (vc1)', () => {
  for (const [check, words] of STATES) {
    const name = `${check.state}/${check.source}`
    it(`${name}: on the Work card, the graph card and the task panel`, async () => {
      const task = inReview(check)
      render(<WorkView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
      const card = screen.getAllByRole('button').find((b) => b.getAttribute('data-task-id') === 'f2a')!
      // A line with no room names «off» briefly; the full reason is on the title.
      expect(card.querySelector('.orc-signals')?.textContent).toContain(check.state === 'off' ? 'no orchestrator check' : words)
      expect(card.querySelector('.orc-signal[title]')?.getAttribute('title')).toBe(words)
      cleanup()

      installMatchMedia(true)
      render(<GraphView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
      const graph = await graphCard()
      expect(graph.getAttribute('aria-label')).toContain(words)
      if (check.state === 'pending' || check.state === 'checking') {
        expect(graph.parentElement?.querySelector('.orc-gnode__checkstate')?.textContent).toContain(check.state === 'pending' ? 'Awaiting check' : 'Orchestrator checking')
      }
      cleanup()

      installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'f2a', status: 'in_review' })) : jsonOk({})))
      render(<TaskPanel repo={repoWith(task)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
      const line = check.state === 'checked' || check.state === 'off' ? screen.getByRole('note') : screen.getByRole('status')
      expect(line.textContent).toContain(words)
      // «Off» links to the setting that turns it on.
      if (check.state === 'off') expect(screen.getByRole('button', { name: 'Change in settings' })).toBeTruthy()
      else expect(screen.queryByRole('button', { name: 'Change in settings' })).toBeNull()
    })

    // Waiting and checking work is the orchestrator's, not in Needs you (vr1).
    if (check.state === 'checked' || check.state === 'off') {
      it(`${name}: in Needs you`, () => {
        const repo = repoWith(inReview(check))
        render(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} />)
        const row = screen.getByRole('region', { name: 'Review queue' }).querySelector('.orc-ibrow')!
        expect(row.querySelector('.orc-ibrow__meta')?.textContent).toContain(check.state === 'off' ? 'no orchestrator check' : words)
        expect(row.getAttribute('title')).toContain(words)
      })
    }
  }

  it('reads in Russian', () => {
    setLang('ru')
    const task = inReview({ state: 'off', source: 'default' })
    installFetch(() => jsonOk(makeDetail({ id: 'f2a', status: 'in_review' })))
    render(<TaskPanel repo={repoWith(task)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    expect(screen.getByRole('note').textContent).toContain('Без проверки оркестратора — выключена для этого плана (нет чата оркестратора)')
  })
})

describe('the verdict where the person decides (vc1, B27)', () => {
  it('shows on the graph card, in Work and in Needs you, with the short reason', async () => {
    const task = inReview({ state: 'off', source: 'default' }, { verdict: { kind: 'disputed', mismatch: 'no_files' } })
    render(<WorkView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
    expect(document.querySelector('[data-task-id="f2a"] .orc-signals')?.textContent).toContain('Disputed · no files changed')
    cleanup()
    installMatchMedia(true)
    render(<GraphView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
    const card = await graphCard()
    expect(card.querySelector('.orc-gnode__verdict')?.textContent).toContain('Disputed')
    expect(card.getAttribute('aria-label')).toContain('Disputed · no files changed')
    cleanup()
    const repo = repoWith(task)
    render(<RepoSidebar snapshot={makeSnapshot(repo)} repo={repo} open onToggle={() => {}} />)
    expect(screen.getByRole('region', { name: 'Review queue' }).querySelector('.orc-ibrow__meta')?.textContent).toContain('Disputed · no files changed')
  })

  it('shows a declared deviation as a caution, not a clean result', () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result', caution: 'deviation' } })
    render(<WorkView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
    const signal = document.querySelector('[data-task-id="f2a"] .orc-signal')!
    expect(signal.className).toContain('orc-verdict--caution')
    expect(signal.textContent).toContain('Result received · deviation declared')
  })

  it('keeps a negative result visible while the orchestrator check is pending', async () => {
    const task = inReview({ state: 'pending', source: 'chat' }, { verdict: { kind: 'negative', why: 'blocked' } })
    installMatchMedia(true)
    render(<GraphView repo={repoWith(task)} selectedId={null} onSelect={() => {}} density="overview" />)
    const card = await graphCard()
    expect(card.querySelector('.orc-gnode__verdict')?.textContent).toContain('Negative result')
    expect(card.parentElement?.querySelector('.orc-gnode__checkstate')?.textContent).toContain('Awaiting check')
  })
})

describe('blocked work asks for an answer (vc1, B27)', () => {
  let calls: FetchCall[] = []
  const mount = (task: TaskSnapshot) => {
    calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review' })) : jsonOk({ runId: 'run-2', agent: 'dsh' })))
    render(<TaskPanel repo={repoWith(task)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  }

  it('returns blocked work through one correction flow that can relaunch it', async () => {
    mount(inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'negative', why: 'blocked' } }))
    expect((await screen.findByRole('button', { name: 'Send back…' })).className).toBe('orc-btn')
    expect(screen.getByRole('button', { name: 'Accept without result' }).className).toContain('orc-btn--ghost')
    expect(screen.queryByRole('button', { name: 'Rerun with note' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Send back…' }))
    expect(screen.getByRole('button', { name: 'Send back' }).className).toBe('orc-btn')
    expect(screen.getByRole('button', { name: 'Send back and rerun' }).className).toContain('orc-btn--ghost')
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason for sending back' }), 'The dependency needs a new implementation task')
    await userEvent.click(screen.getByRole('button', { name: 'Send back and rerun' }))
    const relaunch = calls.find((c) => c.method === 'POST' && c.url.includes('/api/reject'))
    expect(relaunch?.body).toMatchObject({ task: 'f2a', reason: 'The dependency needs a new implementation task', rerun: true })
  })

  it('keeps return primary for a negative result with no claimed blocker', async () => {
    mount(inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'negative', why: 'negative' } }))
    expect((await screen.findByRole('button', { name: 'Send back…' })).className).toBe('orc-btn')
    expect(screen.getByRole('button', { name: 'Accept without result' }).className).toContain('orc-btn--ghost')
    expect(screen.queryByRole('button', { name: 'Rerun with note' })).toBeNull()
  })

  it('keeps return primary when the reported result is disputed', async () => {
    mount(inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'disputed', mismatch: 'no_files' } }))
    expect((await screen.findByRole('button', { name: 'Send back…' })).className).toBe('orc-btn')
    expect(screen.getByRole('button', { name: 'Accept despite mismatch' }).className).toContain('orc-btn--ghost')
  })

  it('keeps return primary when the worker declared a deviation', async () => {
    mount(inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result', caution: 'deviation' } }))
    expect((await screen.findByRole('button', { name: 'Send back…' })).className).toBe('orc-btn')
    expect(screen.getByRole('button', { name: 'Accept with deviation' }).className).toContain('orc-btn--ghost')
  })

  it('keeps Accept as the main action for a result', async () => {
    mount(inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result' } }))
    expect(screen.queryByRole('button', { name: 'Rerun with note' })).toBeNull()
    expect((await screen.findByRole('button', { name: 'Accept' })).className).toBe('orc-btn')
  })

  it('lets the bound orchestrator close routine checked work before asking the person', async () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result' } })
    const repo: OrchestraRepoSnapshot = { ...repoWith(task), plans: [{ id: 'main', goal: 'Plan', current: true, archived: false, rev: 1, updatedAt: '', taskCount: 1, running: 0, inReview: 1, waitingHuman: 1, ready: 0, accepted: 0, attention: [], chat: { sessionId: 'chat', wake: true } }] }
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review' })) : jsonOk({})))
    render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    expect((await screen.findByText('The orchestrator is closing this result or will explain what blocks it.')).textContent).toContain('The orchestrator is closing this result')
    const manual = screen.getByText('Review manually')
    expect(manual.closest('details')?.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Accept' }).closest('details')).toBe(manual.closest('details'))
    await userEvent.click(manual)
    expect(screen.getByRole('button', { name: 'Accept' })).toBeTruthy()
  })

  it('explains an explicit human review requirement instead of hiding its acceptance behind automation', async () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result' } })
    const repo: OrchestraRepoSnapshot = { ...repoWith(task), plans: [{ id: 'main', goal: 'Plan', current: true, archived: false, rev: 1, updatedAt: '', taskCount: 1, running: 0, inReview: 1, waitingHuman: 1, ready: 0, accepted: 0, attention: [], chat: { sessionId: 'chat', wake: true } }] }
    installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review', contract: { path: 'contract.md', text: '<human_review>\nOwner approves layout\n</human_review>', truncated: false } })) : jsonOk({}))
    render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    expect(await screen.findByText('This contract requires your review.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept' }).closest('details')).toBeNull()
  })

  it('does not offer acceptance without review details and can retry the read', async () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'result' } })
    const repo: OrchestraRepoSnapshot = { ...repoWith(task), plans: [{ id: 'main', goal: 'Plan', current: true, archived: false, rev: 1, updatedAt: '', taskCount: 1, running: 0, inReview: 1, waitingHuman: 1, ready: 0, accepted: 0, attention: [], chat: { sessionId: 'chat', wake: true } }] }
    let reads = 0
    installFetch((url) => url.includes('/api/task') ? ++reads === 1 ? jsonFail('unavailable', 503) : jsonOk(makeDetail({ id: task.id, status: 'in_review', contract: { path: 'contract.md', text: '<human_review>\nOwner approves layout\n</human_review>', truncated: false } })) : jsonOk({}))
    render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    expect(await screen.findByText('Task details could not be loaded.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Retry details' }))
    expect(await screen.findByText('This contract requires your review.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Accept' }).closest('details')).toBeNull()
  })

  it('keeps a long orchestrator review note available without filling the action area', async () => {
    const note = 'The branch contains a real dependency on the shared component. The worker cannot complete this step until the contract is updated.'
    mount(inReview({ state: 'checked', source: 'chat' }, { checkNote: note, verdict: { kind: 'negative', why: 'blocked' } }))
    const summary = screen.getByText('Checked by the orchestrator')
    const review = summary.closest('details')
    expect(review?.open).toBe(false)
    await userEvent.click(summary)
    expect(review?.open).toBe(true)
    expect(review?.textContent).toContain(note)
  })

  it('keeps worker routing and worktree paths in an expandable task context', async () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { lane: 'GEOMETRY-DELIVERY', deps: ['geo09'], verdict: { kind: 'negative', why: 'blocked' } })
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review', worktree: { path: '/tmp/geo11-copy', branch: 'orch/geo11' } })) : jsonOk({})))
    render(<TaskPanel repo={repoWith(task)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const summary = screen.getByText('Task context')
    const details = summary.closest('details')
    expect(details?.open).toBe(false)
    await userEvent.click(summary)
    expect(details?.open).toBe(true)
    expect(details?.textContent).toContain('GEOMETRY-DELIVERY')
    expect(details?.textContent).toContain('/tmp/geo11-copy')
  })

  it('keeps historical notes and dependencies available without putting them in the default reading path', async () => {
    const task = inReview({ state: 'checked', source: 'chat' }, { verdict: { kind: 'negative', why: 'blocked' } })
    installFetch((url) => url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, status: 'in_review', notes: [{ at: '2026-09-26T02:00:00Z', type: 'comment', text: 'The root found a prerequisite' }], dependents: ['next'] })) : jsonOk({}))
    render(<TaskPanel repo={repoWith(task)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    const summary = screen.getByText('History and dependencies')
    const history = summary.closest('details')
    expect(history?.open).toBe(false)
    await userEvent.click(summary)
    expect(history?.open).toBe(true)
    expect(history?.textContent).toContain('The root found a prerequisite')
    expect(history?.textContent).toContain('next')
  })

  it('clears the previous task result while the next task detail is loading', async () => {
    const first = inReview({ state: 'checked', source: 'chat' }, { id: 'first', verdict: { kind: 'negative', why: 'blocked' } })
    const second = inReview({ state: 'checked', source: 'chat' }, { id: 'second', verdict: undefined })
    let calls = 0
    const delayed = new Promise<ReturnType<typeof jsonOk>>(() => {})
    installFetch((url) => url.includes('/api/task') ? ++calls === 1 ? jsonOk(makeDetail({ id: 'first', status: 'in_review', verdict: { kind: 'negative', why: 'blocked', facts: [] } })) : delayed : jsonOk({}))
    const view = render(<TaskPanel repo={repoWith(first)} task={first} attention={[]} onSelect={() => {}} density="overview" />)
    expect(await screen.findByText('Negative result')).toBeTruthy()
    view.rerender(<TaskPanel repo={repoWith(second)} task={second} attention={[]} onSelect={() => {}} density="overview" />)
    expect(screen.queryByText('Negative result')).toBeNull()
  })
})

describe('the launch hint (vc1)', () => {
  const mount = (patch: Partial<RepoSnapshot>) => {
    installFetch(() => jsonOk(makeDetail({ id: 'r1' })))
    const task = makeTask({ id: 'r1', title: 'Ready one', status: 'ready' })
    render(<TaskPanel repo={repoWith(task, patch)} task={task} attention={[]} onSelect={() => {}} density="overview" />)
  }

  it('says the check is off, and why, next to Start', () => {
    mount({ orchestratorCheck: { enabled: false, source: 'default' } })
    expect(document.querySelector('.orc-run-route')?.textContent).toContain('The orchestrator check is off for this plan (no orchestrator chat); `crewboard verify --setting on` turns it on.')
  })

  it('says nothing when the check is on', () => {
    mount({ orchestratorCheck: { enabled: true, source: 'chat' } })
    expect(document.querySelector('.orc-run-route')?.textContent).not.toContain('orchestrator check is off')
  })
})
