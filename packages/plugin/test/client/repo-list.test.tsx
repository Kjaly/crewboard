// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrchestraRepoSnapshot } from '../../src/shared/types.js'
import { setLang } from '../../src/client/i18n.js'
import { RepoSidebar } from '../../src/client/sidebar.js'
import { inboxItems, sidebarTree } from '../../src/client/sidebar-model.js'
import { snapshotWaiting } from '../../src/client/review.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import { type FetchCall, ROOT, installFetch, jsonFail, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

let calls: FetchCall[] = []
const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.endsWith(`/api/${name}`))

const listed = (patch: Partial<OrchestraRepoSnapshot> = {}): OrchestraRepoSnapshot =>
  makeRepo([makeTask({ id: 'a' })], [], { root: ROOT, planId: 'main', sources: ['crewboard'], ...patch } as Partial<OrchestraRepoSnapshot>) as OrchestraRepoSnapshot

function mount(repo: OrchestraRepoSnapshot, answer: (url: string) => unknown = () => jsonOk(null), ...others: OrchestraRepoSnapshot[]) {
  calls = installFetch(answer)
  render(<RepoSidebar snapshot={makeSnapshot(repo, ...others)} repo={repo} open onToggle={() => {}} />)
}

const openRepoMenu = async (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getAllByRole('button', { name: /^Actions for repository/ })[0] as HTMLElement)

beforeEach(() => {
  setLang('en')
  localStorage.clear()
  resetOrchestraStore()
})
afterEach(() => cleanup())

describe('«+» next to Repositories adds a repository', () => {
  it('sends the typed path and closes on success', async () => {
    const user = userEvent.setup()
    mount(listed(), (url) => (url.endsWith('/repo-add') ? jsonOk({ root: '/Users/me/src/app' }) : jsonOk(null)))
    await user.click(screen.getByRole('button', { name: 'Add repository' }))
    await user.type(screen.getByRole('textbox', { name: 'Repository folder' }), '~/src/app{Enter}')
    await waitFor(() => expect(posts('repo-add')).toHaveLength(1))
    expect(posts('repo-add')[0]?.body).toEqual({ path: '~/src/app' })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Repository folder' })).toBeNull())
    // «+» no longer starts a plan.
    expect(posts('plan-new')).toHaveLength(0)
  })

  it.each([
    ['repo_not_absolute', 'Enter an absolute path: it starts with / or ~.'],
    ['repo_not_found', 'There is no folder at this path.'],
    ['repo_not_directory', 'This path is a file, not a folder.'],
    ['repo_not_git', 'This folder is not a Git repository or worktree.'],
    ['repo_already_listed', 'This repository is already in the list.'],
  ])('explains %s next to the field and keeps it open', async (code, message) => {
    const user = userEvent.setup()
    mount(listed(), (url) => (url.endsWith('/repo-add') ? jsonFail(code, 400) : jsonOk(null)))
    await user.click(screen.getByRole('button', { name: 'Add repository' }))
    await user.type(screen.getByRole('textbox', { name: 'Repository folder' }), 'src/app{Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', message)
    expect(screen.getByRole('textbox', { name: 'Repository folder' }).getAttribute('aria-invalid')).toBe('true')
  })

  it('words the refusal in Russian too', async () => {
    setLang('ru')
    const user = userEvent.setup()
    mount(listed(), (url) => (url.endsWith('/repo-add') ? jsonFail('repo_already_listed') : jsonOk(null)))
    await user.click(screen.getByRole('button', { name: 'Добавить репозиторий' }))
    await user.type(screen.getByRole('textbox', { name: 'Папка репозитория' }), '/repo{Enter}')
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Этот репозиторий уже в списке.')
  })
})

describe('the repository row menu', () => {
  it('starts a new plan with the goal field, Enter creates it', async () => {
    const user = userEvent.setup()
    mount(listed())
    await openRepoMenu(user)
    await user.click(screen.getByRole('menuitem', { name: 'New plan…' }))
    await user.type(screen.getByRole('textbox', { name: 'New plan goal' }), 'Rewrite the renderer{Enter}')
    await waitFor(() => expect(posts('plan-new')).toHaveLength(1))
    expect(posts('plan-new')[0]?.body).toEqual({ repo: ROOT, goal: 'Rewrite the renderer' })
  })

  it('removes a Crewboard-listed repository from the list only', async () => {
    const user = userEvent.setup()
    mount(listed())
    await openRepoMenu(user)
    const item = screen.getByRole('menuitem', { name: /^Remove from list/ })
    expect(item.textContent).toContain('Files and plans stay on disk')
    await user.click(item)
    await waitFor(() => expect(posts('repo-remove')).toHaveLength(1))
    expect(posts('repo-remove')[0]?.body).toEqual({ root: ROOT })
  })

  it.each([
    [['dsh'], 'A dsh workspace: remove it in dsh'],
    [['profile'], "In the plugin's repos setting of the dsh profile: edit it there"],
  ] as const)('cannot remove a repository that comes from %s, and says why', async (sources, why) => {
    const user = userEvent.setup()
    mount(listed({ sources: [...sources] }))
    await openRepoMenu(user)
    const item = screen.getByRole('menuitem', { name: /^Remove from list/ })
    expect((item as HTMLButtonElement).disabled).toBe(true)
    expect(item.textContent).toContain(why)
    await user.click(item)
    expect(posts('repo-remove')).toHaveLength(0)
  })

  it('marks a folder that is gone as missing and keeps it in view', async () => {
    const gone = listed({ root: '/gone', hasPlan: false, missing: true, tasks: [], plans: [], goal: '' })
    mount(listed(), () => jsonOk(null), gone)
    expect(screen.getByText(/· missing/)).toBeTruthy()
    expect(sidebarTree(makeSnapshot(gone)).quiet).toHaveLength(0)
  })

  it('marks a plan that lives in a discovered worktree', () => {
    const hub = listed({ root: '/repo-hub', worktreeOf: ROOT, family: { root: ROOT, name: 'repo' }, sources: ['worktree'] })
    mount(listed({ family: { root: ROOT, name: 'repo' } }), () => jsonOk(null), hub)
    expect(screen.getAllByText(/· worktree/)).toHaveLength(1)
  })
})

describe('«Needs you» covers plans that are not open', () => {
  it('counts an in-review task of a background plan in a worktree repository', () => {
    const main = listed({ family: { root: ROOT, name: 'repo' } })
    const hub = listed({
      root: '/repo-hub',
      worktreeOf: ROOT,
      family: { root: ROOT, name: 'repo' },
      sources: ['worktree'],
      tasks: [],
      planId: 'main',
      plans: [
        { id: 'main', goal: 'Hub', archived: false, current: true, rev: 1, updatedAt: '2026-09-24T10:00:00Z', taskCount: 0, running: 0, inReview: 0, waitingHuman: 0, ready: 0, accepted: 0, attention: [] },
        { id: 'harness', goal: 'Harness', archived: false, current: false, rev: 1, updatedAt: '2026-09-24T10:00:00Z', taskCount: 1, running: 0, inReview: 1, waitingHuman: 1, ready: 0, accepted: 0, attention: [] },
      ],
    })
    const snapshot = makeSnapshot(main, hub)
    const items = inboxItems(snapshot)
    expect(items.map((i) => ({ root: i.root, planId: i.planId, count: i.count }))).toEqual([{ root: '/repo-hub', planId: 'harness', count: 1 }])
    expect(snapshotWaiting(snapshot)).toBe(1)
    const [group] = sidebarTree(snapshot).repos
    expect(group?.waiting).toBe(1)
  })
})
