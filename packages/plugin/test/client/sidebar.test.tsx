// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attention, OrchestraRepoSnapshot, RepoSnapshot, TaskSnapshot } from '../../src/shared/types.js'
import { agentHandoff } from '../../../core/src/orchestration/handoff.js'
import { CopyForAgent } from '../../src/client/copy-agent.js'
import { taskHandoff } from '../../src/client/handoff.js'
import { setLang } from '../../src/client/i18n.js'
import { LensChip } from '../../src/client/lens-chips.js'
import { snapshotWaiting } from '../../src/client/review.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { applyOrder, defaultGroupOpen, inboxCount, inboxItems, isFinishedPlan, isQuietRepo, moveRow, QUIET_AFTER_MS, rowState, searchSnapshot, shiftRow, sidebarTree } from '../../src/client/sidebar-model.js'
import { installFetch, jsonOk, makeRepo, makeSnapshot, makeTask, ROOT } from './helpers.js'

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(() => cleanup())

const at = (iso: string) => iso
const plan = (p: Record<string, unknown> & { id: string }) => ({
  goal: `Plan ${p.id}`,
  archived: false,
  current: false,
  rev: 1,
  updatedAt: '2026-09-22T11:00:00Z',
  taskCount: 0,
  running: 0,
  inReview: 0,
  waitingHuman: 0,
  ready: 0,
  accepted: 0,
  attention: [],
  ...p,
})

const repo = (root: string, tasks: TaskSnapshot[] = [], attention: Attention[] = [], patch: Partial<RepoSnapshot> = {}): RepoSnapshot =>
  makeRepo(tasks, attention, { root, goal: `Goal ${root}`, planId: 'main', updatedAt: '2026-09-22T12:00:00Z', ...patch })

describe('inboxItems', () => {
  it('collects review, decision and alert rows across repositories, oldest first', () => {
    const a = repo('/a', [
      makeTask({ id: 'rev1', title: 'Ship it', status: 'in_review', activeSince: at('2026-09-20T08:00:00Z') }),
      makeTask({ id: 'ok', status: 'running' }),
    ])
    const b = repo('/b', [
      makeTask({ id: 'dec1', title: 'Choose', kind: 'decision', status: 'ready', needsHuman: true }),
      makeTask({ id: 'run1', title: 'Migrate', status: 'blocked' }),
    ], [{ kind: 'failed', severity: 'alert', taskId: 'run1', runId: 'r1', message: 'exit 1' }])
    const items = inboxItems(makeSnapshot(a, b))
    expect(items.map((i) => i.taskId)).toEqual(['rev1', 'dec1', 'run1'])
    expect(items.map((i) => i.kind)).toEqual(['review', 'decision', 'attention'])
    expect(items[2]?.alert).toBe(true)
    expect(items[0]?.root).toBe('/a')
    expect(items[1]?.root).toBe('/b')
  })

  it('adds one row per waiting background plan and skips hidden repos', () => {
    const bg = repo('/bg', [], [], {
      plans: [
        plan({ id: 'main', current: true }),
        plan({ id: 'later', goal: 'Later work', waitingHuman: 3, updatedAt: '2026-09-21T09:00:00Z' }),
      ],
    })
    const hidden = repo('/secret', [makeTask({ id: 'x', status: 'in_review' })], [], { hidden: true } as Partial<RepoSnapshot>)
    const example = repo('/demo', [makeTask({ id: 'y', status: 'in_review' })], [], { example: true } as Partial<RepoSnapshot>)
    const items = inboxItems(makeSnapshot(bg, hidden, example)).filter((item) => !item.example)
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('plan')
    expect(items[0]?.planId).toBe('later')
    expect(items[0]?.count).toBe(3)
  })

  // One rule for example data: the example's waits are listed (the tour teaches the queue), marked
  // as example and after real rows, and never counted — the same rule as every other total.
  it('lists the example plan\'s waiting task as an example row that counts toward nothing', () => {
    const real = repo('/real', [makeTask({ id: 'rev', title: 'Real review', status: 'in_review', activeSince: at('2026-09-23T08:00:00Z') })])
    const example = repo('/demo', [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true, activeSince: at('2026-09-01T08:00:00Z') })], [], { example: true } as Partial<RepoSnapshot>)
    const snapshot = makeSnapshot(example, real)
    const items = inboxItems(snapshot, { root: '/demo', planId: 'main' })
    expect(items.map((item) => [item.taskId, item.kind, !!item.example])).toEqual([['rev', 'review', false], ['pick', 'decision', true]])
    expect(inboxCount(items)).toBe(1)
    expect(snapshotWaiting(snapshot)).toBe(1)
  })

  // ex1: the example never finishes, so outside its own plan the row was permanent noise.
  it('leaves the example out while another plan is open, or none is', () => {
    const real = repo('/real', [makeTask({ id: 'rev', title: 'Real review', status: 'in_review' })])
    const example = repo('/demo', [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true })], [], { example: true } as Partial<RepoSnapshot>)
    const snapshot = makeSnapshot(example, real)
    expect(inboxItems(snapshot, { root: '/real', planId: 'main' }).map((item) => item.taskId)).toEqual(['rev'])
    expect(inboxItems(snapshot).map((item) => item.taskId)).toEqual(['rev'])
  })

  it('leaves a waiting background example plan out: the open plan is another one', () => {
    const r = repo('/r', [], [], { plans: [plan({ id: 'main', current: true }), plan({ id: 'tour', example: true, waitingHuman: 1 })] })
    expect(inboxItems(makeSnapshot(r), { root: '/r', planId: 'main' })).toEqual([])
    expect(inboxItems(makeSnapshot(r))).toEqual([])
  })

  it('shows the example row in Needs you without a count or an «all clear»', () => {
    const example = repo(ROOT, [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true })], [], { example: true } as Partial<RepoSnapshot>)
    render(<RepoSidebar snapshot={makeSnapshot(example)} repo={example} open onToggle={() => {}} />)
    const inbox = screen.getByRole('region', { name: 'Needs you' })
    expect(inbox.querySelector('h3')?.textContent).toBe('Needs you')
    expect(inbox.textContent).not.toContain('All clear')
    const row = screen.getByRole('button', { name: /Pick a tagline/ })
    expect(row.className).toContain('orc-ibrow--example')
    expect(inbox.querySelector('.orc-inbox__divider')?.textContent).toBe('Example')
  })

  // nq1: «NEEDS YOU · 2» above three rows read as a wrong count. The example rows now sit after the
  // real ones under their own divider, so the count visibly refers to the rows above it.
  it('puts example rows under an «Example» divider after the counted real rows', () => {
    const real = repo('/real', [
      makeTask({ id: 'rev', title: 'Real review', status: 'in_review', activeSince: at('2026-09-23T08:00:00Z') }),
      makeTask({ id: 'dec', title: 'Real decision', kind: 'decision', status: 'ready', needsHuman: true }),
    ])
    const example = repo(ROOT, [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true, activeSince: at('2026-09-01T08:00:00Z') })], [], { example: true } as Partial<RepoSnapshot>)
    render(<RepoSidebar snapshot={makeSnapshot(example, real)} repo={example} open onToggle={() => {}} />)
    const inbox = screen.getByRole('region', { name: 'Needs you' })
    expect(inbox.querySelector('h3')?.textContent).toBe('Needs you · 2')
    const rows = [...inbox.querySelectorAll('.orc-inbox__list > li')].map((li) => (li.classList.contains('orc-inbox__divider') ? '--' : li.querySelector('.orc-ibrow__line')?.textContent))
    expect(rows).toEqual(['Real decision', 'Real review', '--', 'Pick a tagline'])
    expect(inbox.querySelector('.orc-inbox__divider')?.textContent).toBe('Example')
  })

  it('hides the example rows and their divider once another plan is open', () => {
    const real = repo('/real', [makeTask({ id: 'rev', title: 'Real review', status: 'in_review' })])
    const example = repo(ROOT, [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true })], [], { example: true } as Partial<RepoSnapshot>)
    render(<RepoSidebar snapshot={makeSnapshot(example, real)} repo={real} open onToggle={() => {}} />)
    const inbox = screen.getByRole('region', { name: 'Needs you' })
    expect(inbox.querySelector('h3')?.textContent).toBe('Needs you · 1')
    expect(inbox.textContent).not.toContain('Pick a tagline')
    expect(inbox.querySelector('.orc-inbox__divider')).toBeNull()
  })

  it('draws no divider when there is no example row', () => {
    const real = repo('/real', [makeTask({ id: 'rev', title: 'Real review', status: 'in_review' })])
    render(<RepoSidebar snapshot={makeSnapshot(real)} repo={real} open onToggle={() => {}} />)
    expect(screen.getByRole('region', { name: 'Needs you' }).querySelector('.orc-inbox__divider')).toBeNull()
  })

  it('labels the divider in Russian', () => {
    setLang('ru')
    const example = repo(ROOT, [makeTask({ id: 'pick', title: 'Pick a tagline', kind: 'decision', status: 'ready', needsHuman: true })], [], { example: true } as Partial<RepoSnapshot>)
    render(<RepoSidebar snapshot={makeSnapshot(example)} repo={example} open onToggle={() => {}} />)
    expect(document.querySelector('.orc-inbox__divider')?.textContent).toBe('Пример')
  })

  it('reports a background plan whose run failed even when nothing waits', () => {
    const bg = repo('/bg', [], [], {
      plans: [
        plan({ id: 'main', current: true }),
        plan({ id: '3d-editor', goal: '3d editor', waitingHuman: 0, attention: [{ kind: 'failed', severity: 'alert', taskId: 'fp-t25', runId: 'r9', message: 'exit 1' }] }),
      ],
    })
    const items = inboxItems(makeSnapshot(bg))
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('attention')
    expect(items[0]?.planId).toBe('3d-editor')
    // The row opens the affected task, not just the plan.
    expect(items[0]?.taskId).toBe('fp-t25')
    expect(items[0]?.alert).toBe(true)
    expect(items[0]?.message).toBe('exit 1')
  })
})

describe('rowState', () => {
  it('picks the highest-priority state: failed over waiting over running', () => {
    expect(rowState({ running: 1, waiting: 1, failed: 1 })).toBe('failed')
    expect(rowState({ running: 2, waiting: 1, failed: 0 })).toBe('waiting')
    expect(rowState({ running: 3, waiting: 0, failed: 0 })).toBe('running')
    expect(rowState({ running: 0, waiting: 0, failed: 0 })).toBe('idle')
  })
})

describe('sidebarTree', () => {
  it('merges copies of one repository into a single group of plans', () => {
    const a = repo('/wt/ap-a', [], [], {
      family: { root: '/repo/main', name: 'app' },
      plans: [plan({ id: 'main', current: true, goal: 'From copy A' })],
    } as Partial<RepoSnapshot>)
    const b = repo('/wt/ap-b', [], [], {
      family: { root: '/repo/main', name: 'app' },
      plans: [plan({ id: 'main', current: true, goal: 'From copy B' })],
    } as Partial<RepoSnapshot>)
    const c = repo('/other')
    const tree = sidebarTree(makeSnapshot(a, b, c))
    const groups = [...tree.pinned, ...tree.repos]
    const family = groups.find((g) => g.id === '/repo/main')
    expect(family?.name).toBe('app')
    expect(family?.members.map((m) => m.repo.root).sort()).toEqual(['/wt/ap-a', '/wt/ap-b'])
    // The copies' plans sit directly in the group — there is no copy level.
    expect(family?.plans.map((row) => `${row.entry.repo.root}:${row.plan.id}`).sort()).toEqual(['/wt/ap-a:main', '/wt/ap-b:main'])
    expect(groups.some((g) => g.id === '/other' && g.members.length === 1)).toBe(true)
  })

  it('puts pinned first, waiting groups before quiet ones, planless stale repos into Quiet and hidden ones into Hidden', () => {
    const stale = repo('/stale', [], [], { hasPlan: false, lastActivityAt: '2026-09-01T00:00:00Z' } as Partial<RepoSnapshot>)
    const freshNoPlan = repo('/fresh', [], [], { hasPlan: false, lastActivityAt: '2026-09-22T00:00:00Z' } as Partial<RepoSnapshot>)
    const pinnedRepo = repo('/pin', [], [], { pinned: true, lastActivityAt: '2026-09-01T00:00:00Z' } as Partial<RepoSnapshot>)
    const hiddenRepo = repo('/hid', [], [], { hidden: true } as Partial<RepoSnapshot>)
    const waitingRepo = repo('/need', [], [], {
      lastActivityAt: '2026-09-10T00:00:00Z',
      plans: [plan({ id: 'main', waitingHuman: 1 })],
    } as Partial<RepoSnapshot>)
    const idle = repo('/idle', [], [], { lastActivityAt: '2026-09-21T00:00:00Z' } as Partial<RepoSnapshot>)
    const now = Date.parse('2026-09-22T12:00:00Z')
    const tree = sidebarTree(makeSnapshot(stale, freshNoPlan, pinnedRepo, hiddenRepo, idle, waitingRepo), now)
    expect(tree.pinned[0]?.members[0]?.repo.root).toBe('/pin')
    expect(tree.quiet.map((g) => g.members[0]?.repo.root)).toEqual(['/stale'])
    expect(tree.hidden.map((g) => g.members[0]?.repo.root)).toEqual(['/hid'])
    // The waiting group outranks the fresher idle one; the fresh planless repo stays visible.
    expect(tree.repos.map((g) => g.id)).toEqual(['/need', '/idle', '/fresh'])
    expect(isQuietRepo(stale, now)).toBe(true)
    expect(isQuietRepo(freshNoPlan, now)).toBe(false)
    expect(Date.parse('2026-09-01T00:00:00Z') + QUIET_AFTER_MS < now).toBe(true)
  })

  it('opens by default the group of the current plan and any group with waiting or running work', () => {
    const current = repo('/cur')
    const waiting = repo('/wait', [], [], { plans: [plan({ id: 'main', waitingHuman: 1 })] } as Partial<RepoSnapshot>)
    const running = repo('/run', [], [], { plans: [plan({ id: 'main', running: 1 })] } as Partial<RepoSnapshot>)
    const idle = repo('/idle', [], [], { plans: [plan({ id: 'main' })] } as Partial<RepoSnapshot>)
    const tree = sidebarTree(makeSnapshot(current, waiting, running, idle))
    const group = (id: string) => [...tree.repos, ...tree.pinned].find((g) => g.id === id)!
    expect(defaultGroupOpen(group('/cur'), '/cur')).toBe(true)
    expect(defaultGroupOpen(group('/wait'), '/cur')).toBe(true)
    expect(defaultGroupOpen(group('/run'), '/cur')).toBe(true)
    expect(defaultGroupOpen(group('/idle'), '/cur')).toBe(false)
  })

  it('marks a plan finished only when nothing in it can still move', () => {
    const done = plan({ id: 'done', taskCount: 4, accepted: 4 })
    expect(isFinishedPlan(done as never)).toBe(true)
    for (const patch of [
      { running: 1 },
      { waitingHuman: 1 },
      { inReview: 1 },
      { ready: 1 },
      { accepted: 3 },
      { taskCount: 0, accepted: 0 },
      { archived: true },
      { attention: [{ kind: 'failed', severity: 'alert' }] },
    ]) {
      expect(isFinishedPlan(plan({ id: 'x', taskCount: 4, accepted: 4, ...patch }) as never)).toBe(false)
    }
  })
})

describe('searchSnapshot', () => {
  it('finds repositories, plans and tasks across the snapshot', () => {
    const a = repo('/a', [makeTask({ id: 'fetch', title: 'Fetch titles' })], [], { plans: [plan({ id: 'main', current: true, goal: 'Parser' })] })
    const b = repo('/bravo', [makeTask({ id: 'br1', title: 'Build' })])
    const hits = searchSnapshot(makeSnapshot(a, b), 'br')
    expect(hits[0]?.kind).toBe('repo')
    expect(hits[0]?.root).toBe('/bravo')
    const taskHits = searchSnapshot(makeSnapshot(a, b), 'fetch')
    expect(taskHits.some((h) => h.kind === 'task' && h.taskId === 'fetch' && h.root === '/a')).toBe(true)
    expect(searchSnapshot(makeSnapshot(a, b), 'parser').some((h) => h.kind === 'plan')).toBe(true)
    expect(searchSnapshot(makeSnapshot(a, b), '')).toEqual([])
  })
})

describe('sidebar tree rendering', () => {
  const mount = (snapshot: ReturnType<typeof makeSnapshot>, current: OrchestraRepoSnapshot) => {
    installFetch(() => jsonOk(null))
    render(<RepoSidebar snapshot={snapshot} repo={current} open onToggle={() => {}} />)
    return screen.getByRole('navigation', { name: 'Repositories' })
  }

  it('lists a family’s plans under one group without a copy level', () => {
    const a = repo('/wt/ap-a', [], [], {
      family: { root: '/repo/main', name: 'app' },
      plans: [plan({ id: 'main', current: true, goal: 'Alpha plan' })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    const b = repo('/wt/ap-b', [], [], {
      family: { root: '/repo/main', name: 'app' },
      plans: [plan({ id: 'fix', goal: 'Beta plan', waitingHuman: 1 })],
    } as Partial<RepoSnapshot>)
    mount(makeSnapshot(a, b), a)
    expect(screen.getByRole('treeitem', { name: /app/ })).toBeTruthy()
    // Copy folder names are not rows: they only live in the plan row's tooltip.
    expect(screen.queryByRole('treeitem', { name: /^ap-a/ })).toBeNull()
    expect(screen.queryByRole('treeitem', { name: /^ap-b/ })).toBeNull()
    expect(screen.getByRole('treeitem', { name: /Alpha plan/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /Beta plan/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /Alpha plan/ }).getAttribute('title')).toContain('ap-a')
    expect(screen.getByRole('treeitem', { name: /Alpha plan/ }).getAttribute('title')).toContain('/wt/ap-a')
  })

  it('expands the current and busy groups by default and summarizes the rest', () => {
    const current = repo('/cur', [], [], { plans: [plan({ id: 'main', current: true, goal: 'Current plan' })] } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    const busy = repo('/busy', [], [], { plans: [plan({ id: 'w', goal: 'Busy plan', running: 1 })] } as Partial<RepoSnapshot>)
    const idle = repo('/idle', [], [], { plans: [plan({ id: 'one' }), plan({ id: 'two' })] } as Partial<RepoSnapshot>)
    mount(makeSnapshot(current, busy, idle), current)
    expect(screen.getByRole('treeitem', { name: /Current plan/ })).toBeTruthy()
    expect(screen.getByRole('treeitem', { name: /Busy plan/ })).toBeTruthy()
    // The idle group stays folded: its plans are not rows, only the count in the tooltip.
    expect(screen.queryByRole('treeitem', { name: /Plan one/ })).toBeNull()
    expect(screen.getByRole('treeitem', { name: /idle/ }).getAttribute('title')).toContain('2 plans')
  })

  it('keeps the manual fold choice per viewer', async () => {
    const user = userEvent.setup()
    const current = repo('/cur', [], [], { plans: [plan({ id: 'main', current: true, goal: 'Current plan' })] } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    const row = screen.getByRole('treeitem', { name: /cur/ })
    await user.click(row)
    expect(screen.queryByRole('treeitem', { name: /Current plan/ })).toBeNull()
    expect(localStorage.getItem('crewboard:side-folds')).toContain('false')
    cleanup()
    mount(makeSnapshot(current), current)
    expect(screen.queryByRole('treeitem', { name: /Current plan/ })).toBeNull()
    expect(screen.getByRole('treeitem', { name: /cur/ }).getAttribute('title')).toContain('1 plan')
  })

  it('folds finished plans into their own row inside the group', async () => {
    const user = userEvent.setup()
    const current = repo('/cur', [], [], {
      plans: [
        plan({ id: 'main', current: true, goal: 'Live plan', ready: 1, taskCount: 2, accepted: 1 }),
        plan({ id: 'done', goal: 'Finished plan', taskCount: 3, accepted: 3 }),
      ],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    expect(screen.queryByRole('treeitem', { name: /Finished plan/ })).toBeNull()
    const fold = screen.getByRole('treeitem', { name: '1 finished plan' })
    await user.click(fold)
    expect(screen.getByRole('treeitem', { name: /Finished plan/ })).toBeTruthy()
  })

  it('lets exactly one row carry the selected state — the current plan', () => {
    const current = repo('/cur', [], [], {
      plans: [plan({ id: 'main', current: true, goal: 'Current plan' }), plan({ id: 'other', goal: 'Other plan', waitingHuman: 1 })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    const tree = document.querySelector('.orc-tree__list')!
    expect(tree.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    expect(tree.querySelectorAll('[aria-selected="true"]')).toHaveLength(1)
    expect(screen.getByRole('treeitem', { name: /Current plan/ }).getAttribute('aria-current')).toBe('true')
  })

  // vr1: in-review work the orchestrator is still checking is not «waiting» on the plan row.
  it('does not count in-review tasks the orchestrator is checking as waiting', () => {
    const current = repo('/cur', [], [], {
      plans: [plan({ id: 'main', current: true, goal: 'Plan', taskCount: 3, inReview: 3, waitingHuman: 1 })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    expect(screen.getByRole('treeitem', { name: /Plan/ }).querySelector('.orc-srow__state')?.getAttribute('aria-label')).toBe('1 waiting')
  })

  it('reduces a plan row to one status mark whose label spells the counts out', () => {
    const current = repo('/cur', [], [], {
      plans: [plan({ id: 'main', current: true, goal: 'Plan', taskCount: 7, accepted: 3, running: 1, inReview: 2, waitingHuman: 2, attention: [{ kind: 'failed', severity: 'alert', taskId: 't', runId: 'r', message: 'boom' }] })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    const row = screen.getByRole('treeitem', { name: /Plan/ })
    // Exactly one mark, and the highest-priority state wins: failed over waiting over running.
    const marks = row.querySelectorAll('.orc-srow__state')
    expect(marks).toHaveLength(1)
    expect(marks[0]?.getAttribute('aria-label')).toBe('1 running · 2 waiting · 1 failed')
    expect(marks[0]?.getAttribute('title')).toBe('1 running · 2 waiting · 1 failed')
    expect(marks[0]?.querySelector('.orc-sdot--failed')).toBeTruthy()
    // The accepted count rides along but is styled to surface only on hover or focus.
    const peek = row.querySelector('.orc-srow__peek')
    expect(peek?.textContent).toBe('3/7')
    // The expanded group row shows no counter text at all.
    expect(screen.getByRole('treeitem', { name: /cur/ }).textContent).not.toContain('running')
  })

  it('shows the aggregated mark on a collapsed repository', () => {
    const current = repo('/cur', [], [], { plans: [plan({ id: 'main', current: true, goal: 'Calm' })] } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    const trouble = repo('/alarm', [], [], {
      plans: [plan({ id: 'main', goal: 'Failing', attention: [{ kind: 'failed', severity: 'alert', taskId: 't', runId: 'r', message: 'boom' }] })],
    } as Partial<RepoSnapshot>)
    mount(makeSnapshot(current, trouble), current)
    // Attention alone does not open a group, so /alarm renders folded with one mark.
    const row = screen.getByRole('treeitem', { name: /alarm/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    const mark = row.querySelector('.orc-srow__state')
    expect(mark?.getAttribute('aria-label')).toBe('1 failed')
    expect(mark?.querySelector('.orc-sdot--failed')).toBeTruthy()
  })

  it('marks running work with the pixel chase and waiting work with a warning dot', () => {
    const current = repo('/cur', [], [], {
      plans: [
        plan({ id: 'main', current: true, goal: 'Live', running: 2 }),
        plan({ id: 'wait', goal: 'Review me', waitingHuman: 1 }),
        plan({ id: 'calm', goal: 'Quiet plan', ready: 1 }),
      ],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    const live = screen.getByRole('treeitem', { name: /Live/ })
    expect(live.querySelector('.orc-srow__state .orc-sdot-matrix')).toBeTruthy()
    expect(live.querySelector('.orc-srow__state')?.getAttribute('aria-label')).toBe('2 running')
    const wait = screen.getByRole('treeitem', { name: /Review me/ })
    expect(wait.querySelector('.orc-srow__state .orc-sdot--waiting')).toBeTruthy()
    expect(wait.querySelector('.orc-srow__state')?.getAttribute('aria-label')).toBe('1 waiting')
    // A plan with nothing pending draws no mark at all.
    expect(screen.getByRole('treeitem', { name: /Quiet plan/ }).querySelector('.orc-srow__state')).toBeNull()
  })

  it('returns focus to the row trigger after a menu action that stays in place', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const current = repo('/cur', [], [], { plans: [plan({ id: 'main', current: true, goal: 'Current plan' })] } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    mount(makeSnapshot(current), current)
    const trigger = screen.getByRole('button', { name: 'Actions for plan “Current plan”' })
    await user.click(trigger)
    await user.click(screen.getByRole('menuitem', { name: 'Copy for agent' }))
    await waitFor(() => expect(document.activeElement).toBe(trigger))
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('sidebar keyboard navigation', () => {
  const mount = () => {
    installFetch(() => jsonOk(null))
    const r = repo(ROOT, [makeTask({ id: 'a' })], [], { plans: [plan({ id: 'main', current: true, goal: 'Main goal' }), plan({ id: 'two', goal: 'Second', ready: 1 })] }) as OrchestraRepoSnapshot
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    return screen.getByRole('navigation', { name: 'Repositories' })
  }

  it('walks rows with arrows, folds with Left/Right and opens on Enter', () => {
    const nav = mount()
    expect(nav).toBeTruthy()
    const repoRow = screen.getByRole('treeitem', { name: /^repo/ })
    // A click folds the group; keyboard walking starts from a focused row, so focus directly.
    repoRow.focus()
    fireEvent.keyDown(repoRow, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Main goal' }))
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Main goal' }), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Second' }))
    fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Second' }), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(repoRow)
    fireEvent.keyDown(repoRow, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByRole('treeitem', { name: 'Main goal' }))
  })
})

describe('copy for agent', () => {
  it('writes the agentHandoff text to the clipboard', async () => {
    const r = repo(ROOT, [makeTask({ id: 'a', title: 'Do the thing', status: 'in_review' })])
    const task = r.tasks[0]!
    render(<CopyForAgent text={taskHandoff(r, task)} />)
    const user = userEvent.setup()
    // userEvent installs its own clipboard stub on setup — spy after it so the copy lands here.
    const writeText = vi.fn(async (_text: string) => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await user.click(screen.getByRole('button', { name: 'Copy for agent' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    const expected = agentHandoff({ kind: 'task', repo: r.root, planId: r.planId, task: { id: task.id, title: task.title, status: task.status, kind: task.kind } }, 'en')
    expect(writeText.mock.calls[0]?.[0]).toBe(expected)
    expect(screen.getByRole('button').textContent).toBe('Copied')
  })
})

describe('status chip list', () => {
  const mount = () => {
    const r = repo(ROOT, [
      makeTask({ id: 'w1', title: 'First wait', status: 'in_review', activeSince: '2026-09-22T10:00:00Z' }),
      makeTask({ id: 'w2', title: 'Second wait', status: 'in_review', activeSince: '2026-09-22T11:00:00Z' }),
    ], [
      { kind: 'failed', severity: 'alert', taskId: 'w1', runId: 'r1', message: 'exit 1' },
      { kind: 'stalled', severity: 'warn', taskId: 'w2', runId: 'r2', message: 'quiet worker' },
    ])
    const onLens = vi.fn()
    const onPick = vi.fn()
    render(<LensChip kind="attention" count={2} repo={r} active={false} onLens={onLens} onPick={onPick} />)
    return { onLens, onPick }
  }

  it('clicking the chip turns its lens on and opens the list; a row picks its task', async () => {
    const user = userEvent.setup()
    const { onLens, onPick } = mount()
    await user.click(screen.getByRole('button', { name: /Needs attention/ }))
    expect(onLens).toHaveBeenCalledWith('attention')
    const list = screen.getByRole('listbox')
    expect(list).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(2)
    // Alert first, then oldest: the failed run outranks the fresher wait.
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('w1')
    await user.click(screen.getAllByRole('option')[1]!)
    expect(onPick).toHaveBeenCalledWith('w2')
  })

  it('Escape closes the list and releases the lens', async () => {
    const user = userEvent.setup()
    const { onLens } = mount()
    await user.click(screen.getByRole('button', { name: /Needs attention/ }))
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(onLens).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('sidebar order model', () => {
  const three = () => [repo('/a'), repo('/b'), repo('/c')]

  it('applies a saved repository order and appends rows the order does not know', () => {
    const tree = sidebarTree(makeSnapshot(...three()), 0, { repos: ['/b', '/a'] })
    expect(tree.repos.map((g) => g.id)).toEqual(['/b', '/a', '/c'])
    // Without a saved list the automatic rule — name order here — decides.
    expect(sidebarTree(makeSnapshot(...three()), 0).repos.map((g) => g.id)).toEqual(['/a', '/b', '/c'])
  })

  it('orders plans inside one group and leaves the other groups alone', () => {
    const a = repo('/a', [], [], {
      plans: [plan({ id: 'one', updatedAt: '2026-09-22T10:00:00Z' }), plan({ id: 'two', updatedAt: '2026-09-22T11:00:00Z' })],
    } as Partial<RepoSnapshot>)
    const b = repo('/b', [], [], { plans: [plan({ id: 'x' })] } as Partial<RepoSnapshot>)
    const tree = sidebarTree(makeSnapshot(a, b), 0, { plans: { '/a': ['/a/one', '/a/two'] } })
    const group = tree.repos.find((g) => g.id === '/a')
    expect(group?.plans.map((row) => row.plan.id)).toEqual(['one', 'two'])
    expect(tree.repos.find((g) => g.id === '/b')?.plans.map((row) => row.plan.id)).toEqual(['x'])
  })

  it('orders a family group by its family root, as one row', () => {
    const copy = repo('/wt/ap-a', [], [], { family: { root: '/repo/app', name: 'app' } } as Partial<RepoSnapshot>)
    const other = repo('/other')
    const tree = sidebarTree(makeSnapshot(copy, other), 0, { repos: ['/other', '/repo/app'] })
    expect(tree.repos.map((g) => g.id)).toEqual(['/other', '/repo/app'])
  })

  it('keeps pinned rows in their own leading section under a saved order', () => {
    const pinnedRepo = repo('/pin', [], [], { pinned: true, lastActivityAt: '2026-09-01T00:00:00Z' } as Partial<RepoSnapshot>)
    const tree = sidebarTree(makeSnapshot(repo('/a'), repo('/b'), pinnedRepo), 0, { repos: ['/b', '/pin', '/a'] })
    expect(tree.pinned.map((g) => g.id)).toEqual(['/pin'])
    expect(tree.repos.map((g) => g.id)).toEqual(['/b', '/a'])
  })

  it('moveRow re-inserts a row before or after its target and shiftRow steps by one', () => {
    expect(moveRow(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a'])
    expect(moveRow(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b'])
    // Dropping next to a neighbour the row already has changes nothing.
    expect(moveRow(['a', 'b', 'c'], 'a', 'b', 'before')).toEqual(['a', 'b', 'c'])
    expect(shiftRow(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(shiftRow(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
    expect(applyOrder([3, 1, 2], (n) => String(n), ['1', '2'])).toEqual([1, 2, 3])
  })
})

describe('sidebar reorder interactions', () => {
  const twoPlans = () =>
    repo(ROOT, [], [], {
      plans: [plan({ id: 'main', current: true, goal: 'Main goal', updatedAt: '2026-09-22T11:00:00Z' }), plan({ id: 'two', goal: 'Second', ready: 1, updatedAt: '2026-09-22T10:00:00Z' })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot

  const planRow = (name: string) => screen.getByRole('treeitem', { name }).parentElement!
  const orderCalls = (calls: ReturnType<typeof installFetch>) => calls.filter((c) => c.url.endsWith('/side-order'))
  /** jsdom rows have zero-height rects: any drop lands after the list's last row. */
  const drag = (row: HTMLElement, y = 60) => {
    fireEvent.pointerDown(row, { button: 0, clientX: 8, clientY: 8, pointerId: 7 })
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, clientX: 8, clientY: y, bubbles: true }))
      window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 7, bubbles: true }))
    })
  }

  it('moves a plan row with Alt+ArrowDown, announces it and saves', async () => {
    const calls = installFetch(() => jsonOk({}))
    const r = twoPlans()
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    const row = screen.getByRole('treeitem', { name: 'Main goal' })
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowDown', altKey: true })
    expect(orderCalls(calls)[0]?.body).toMatchObject({ order: { plans: { [ROOT]: [`${ROOT}/two`, `${ROOT}/main`] } } })
    // The row order changes at once and the live region speaks the new position.
    const names = Array.from(document.querySelectorAll('.orc-srow__main--plan .orc-srow__name')).map((el) => el.textContent)
    expect(names.indexOf('Second')).toBeLessThan(names.indexOf('Main goal'))
    expect(screen.getByRole('status').textContent).toContain('2 of 2')
  })

  it('moves a repository row with Alt+ArrowUp', () => {
    const calls = installFetch(() => jsonOk(null))
    const a = repo('/a')
    const b = repo('/b') as OrchestraRepoSnapshot
    render(<RepoSidebar snapshot={makeSnapshot(a, b)} repo={b} open onToggle={() => {}} />)
    const row = screen.getByRole('treeitem', { name: 'b' })
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowUp', altKey: true })
    expect(orderCalls(calls)[0]?.body).toMatchObject({ order: { repos: ['/b', '/a'] } })
    expect(screen.getByRole('status').textContent).toContain('1 of 2')
  })

  it('drags a plan row after the threshold and saves the new order on release', () => {
    const calls = installFetch(() => jsonOk(null))
    const r = twoPlans()
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    const row = planRow('Main goal')
    fireEvent.pointerDown(row, { button: 0, clientX: 8, clientY: 8, pointerId: 7 })
    // A sub-threshold nudge is still a pending click: no ghost, no indicator.
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, clientX: 10, clientY: 10, bubbles: true }))
    })
    expect(document.querySelector('.orc-sdrag')).toBeNull()
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, clientX: 8, clientY: 60, bubbles: true }))
    })
    expect(document.querySelector('.orc-sdrag')).toBeTruthy()
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 7, bubbles: true }))
    })
    expect(document.querySelector('.orc-sdrag')).toBeNull()
    expect(orderCalls(calls)[0]?.body).toMatchObject({ order: { plans: { [ROOT]: [`${ROOT}/two`, `${ROOT}/main`] } } })
  })

  it('keeps a dragged plan inside its own repository', () => {
    const calls = installFetch(() => jsonOk(null))
    const a = repo('/a', [], [], {
      plans: [plan({ id: 'one', current: true, goal: 'First plan', updatedAt: '2026-09-22T11:00:00Z' }), plan({ id: 'two', goal: 'Second plan', updatedAt: '2026-09-22T10:00:00Z' })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    // The neighbour group is open (its plan waits on the person): its rows are on screen but never valid targets.
    const b = repo('/b', [], [], { plans: [plan({ id: 'x', goal: 'Other plan', waitingHuman: 1 })] } as Partial<RepoSnapshot>)
    render(<RepoSidebar snapshot={makeSnapshot(a, b)} repo={a} open onToggle={() => {}} />)
    drag(planRow('First plan'))
    const body = orderCalls(calls)[0]?.body as { order: { plans: Record<string, string[]> } }
    expect(Object.keys(body.order.plans)).toEqual(['/a'])
    expect(body.order.plans['/a']).toEqual(['/a/two', '/a/one'])
  })

  it('never starts a drag from the menu button or the status mark', () => {
    const calls = installFetch(() => jsonOk(null))
    const r = repo(ROOT, [], [], {
      plans: [plan({ id: 'main', current: true, goal: 'Main goal', waitingHuman: 1 })],
    } as Partial<RepoSnapshot>) as OrchestraRepoSnapshot
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    for (const target of [
      screen.getByRole('button', { name: 'Actions for plan “Main goal”' }),
      document.querySelector('.orc-srow__state')!,
    ]) {
      fireEvent.pointerDown(target, { button: 0, clientX: 8, clientY: 8, pointerId: 7 })
      act(() => {
        window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, clientX: 8, clientY: 60, bubbles: true }))
        window.dispatchEvent(new window.PointerEvent('pointerup', { pointerId: 7, bubbles: true }))
      })
    }
    expect(document.querySelector('.orc-sdrag')).toBeNull()
    expect(orderCalls(calls)).toHaveLength(0)
  })

  it('cancels a drag with Escape', () => {
    const calls = installFetch(() => jsonOk(null))
    const r = twoPlans()
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    fireEvent.pointerDown(planRow('Main goal'), { button: 0, clientX: 8, clientY: 8, pointerId: 7 })
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { pointerId: 7, clientX: 8, clientY: 60, bubbles: true }))
    })
    expect(document.querySelector('.orc-sdrag')).toBeTruthy()
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.querySelector('.orc-sdrag')).toBeNull()
    expect(orderCalls(calls)).toHaveLength(0)
  })

  it('offers Move up/down in the row menu and disables the boundary step', async () => {
    const calls = installFetch(() => jsonOk(null))
    const user = userEvent.setup()
    const r = twoPlans()
    render(<RepoSidebar snapshot={makeSnapshot(r)} repo={r} open onToggle={() => {}} />)
    await user.click(screen.getByRole('button', { name: 'Actions for plan “Main goal”' }))
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toHaveProperty('disabled', true)
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }))
    expect(orderCalls(calls)[0]?.body).toMatchObject({ order: { plans: { [ROOT]: [`${ROOT}/two`, `${ROOT}/main`] } } })
  })

  it('resets to the automatic order from the Repositories section menu', async () => {
    const calls = installFetch(() => jsonOk(null))
    const user = userEvent.setup()
    const a = repo('/a')
    const b = repo('/b') as OrchestraRepoSnapshot
    render(<RepoSidebar snapshot={{ ...makeSnapshot(a, b), order: { repos: ['/b', '/a'] } }} repo={b} open onToggle={() => {}} />)
    const names = () => Array.from(document.querySelectorAll('.orc-tree__list > li .orc-srow__main--repo .orc-srow__name')).map((el) => el.textContent)
    expect(names()).toEqual(['b', 'a'])
    await user.click(screen.getByRole('button', { name: 'Repositories section menu' }))
    await user.click(screen.getByRole('menuitem', { name: 'Reset order' }))
    expect(orderCalls(calls)[0]?.body).toMatchObject({ order: null })
    expect(names()).toEqual(['a', 'b'])
  })
})
