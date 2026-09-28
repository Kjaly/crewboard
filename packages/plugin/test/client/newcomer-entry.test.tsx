// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App } from '../../src/client/app.js'
import { setLang } from '../../src/client/i18n.js'
import { isQuietRepo, sidebarTree } from '../../src/client/sidebar-model.js'
import { resetOrchestraStore } from '../../src/client/store.js'
import { TOUR_KEY } from '../../src/client/tour.js'
import { FakeEventSource, installEventSource, installFetch, installMatchMedia, jsonOk, makeRepo, makeSnapshot, makeTask } from './helpers.js'

// nb1 (B31): a new repository opens where the first task starts.

beforeEach(() => { setLang('en'); localStorage.clear(); resetOrchestraStore(); installEventSource(); installMatchMedia(false) })
afterEach(() => cleanup())

const busy = makeRepo([makeTask({ id: 'a', title: 'First' })], [], { hasPlan: true, planId: 'main' })
const fresh = makeRepo([], [], { root: '/work/fresh', hasPlan: false, goal: '' })

function fetches(respond: (url: string) => unknown = () => undefined) {
  return installFetch((url) => {
    const answer = respond(url)
    if (answer) return answer
    if (url.includes('/onboarding-workers')) return jsonOk([])
    if (url.includes('/recipe?')) return jsonOk({ recipe: null, detected: { setup: [], env: { unset: [] }, timeoutSec: 300 } })
    if (url.includes('/plan-drafts') || url.includes('/plan-draft-jobs')) return jsonOk([])
    return jsonOk(null)
  })
}

const emit = async (snapshot: ReturnType<typeof makeSnapshot>) => act(async () => FakeEventSource.last?.emit('snapshot', snapshot))

describe('sidebar', () => {
  it('keeps a repository without history out of «Quiet»; one with an old history goes there', () => {
    const now = Date.parse('2026-09-25T12:00:00Z')
    expect(isQuietRepo(fresh, now)).toBe(false)
    expect(isQuietRepo({ ...fresh, lastActivityAt: '2026-09-01T00:00:00Z' }, now)).toBe(true)
    const tree = sidebarTree(makeSnapshot(busy, fresh), now)
    expect(tree.quiet).toEqual([])
    expect(tree.repos.map((group) => group.id)).toContain('/work/fresh')
  })

  it('opens the welcome when a repository without a plan is clicked', async () => {
    const user = userEvent.setup()
    fetches()
    render(<App />)
    await emit(makeSnapshot(busy, fresh))
    expect(screen.queryByRole('heading', { name: 'How to start' })).toBeNull()
    await user.click(screen.getByRole('treeitem', { name: /^fresh/ }))
    expect(await screen.findByRole('heading', { name: 'How to start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fresh' })).toBeTruthy()
  })

  it('opens a repository added with «+» on its welcome', async () => {
    const user = userEvent.setup()
    const calls = fetches((url) => (url.endsWith('/repo-add') ? jsonOk({ root: '/work/fresh' }) : undefined))
    render(<App />)
    await emit(makeSnapshot(busy))
    await user.click(screen.getByRole('button', { name: 'Add repository' }))
    await user.type(screen.getByRole('textbox', { name: 'Repository folder' }), '/work/fresh{Enter}')
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/repo-add'))?.body).toMatchObject({ path: '/work/fresh' }))
    await emit(makeSnapshot(busy, fresh))
    expect(await screen.findByRole('heading', { name: 'How to start' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'fresh' })).toBeTruthy()
  })
})

describe('welcome', () => {
  it('without any repository, takes a path and adds it right there', async () => {
    const user = userEvent.setup()
    const calls = fetches((url) => (url.endsWith('/repo-add') ? jsonOk({ root: '/work/fresh' }) : undefined))
    render(<App />)
    await emit(makeSnapshot())
    expect(screen.queryByRole('button', { name: 'Open settings' })).toBeNull()
    const card = screen.getByRole('region', { name: 'Add a repository' })
    await user.type(within(card).getByRole('textbox', { name: 'Repository folder' }), '~/src/fresh')
    await user.click(within(card).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/repo-add'))?.body).toMatchObject({ path: '~/src/fresh' }))
    await emit(makeSnapshot(fresh))
    expect(await screen.findByRole('heading', { name: 'How to start' })).toBeTruthy()
  })

  it('offers «Add task» and «Draft from spec» on an empty plan, and adds the task', async () => {
    const user = userEvent.setup()
    const calls = fetches((url) => (url.endsWith('/task-add') ? jsonOk({ id: 'add-a-sign-in-form' }) : undefined))
    render(<App />)
    await emit(makeSnapshot(makeRepo([], [], { hasPlan: true, planId: 'main' })))
    expect(screen.getByRole('heading', { name: 'Add the first task' })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Draft from spec/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /See an example/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Add task/ }))
    await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Add a sign-in form')
    await user.type(screen.getByRole('textbox', { name: 'Done when (optional)' }), 'The form signs in')
    await user.click(screen.getByRole('button', { name: 'Create task' }))
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/task-add'))?.body).toEqual({ repo: '/repo', title: 'Add a sign-in form', result: 'The form signs in' }))
  })

  it('asks for the goal before «From chat» creates a plan', async () => {
    const user = userEvent.setup()
    const calls = fetches((url) => (url.endsWith('/chat-open') ? jsonOk({ sessionId: 's1', created: true }) : undefined))
    render(<App />)
    await emit(makeSnapshot(makeRepo([], [], { hasPlan: false, goal: '' })))
    await user.click(screen.getByRole('button', { name: /From chat/ }))
    expect(calls.some((call) => call.url.endsWith('/chat-open'))).toBe(false)
    await user.type(screen.getByRole('textbox', { name: 'Goal of the plan' }), 'A faster checkout')
    await user.click(screen.getByRole('button', { name: 'Open chat' }))
    await waitFor(() => expect(calls.find((call) => call.url.endsWith('/chat-open'))?.body).toMatchObject({ repo: '/repo', goal: 'A faster checkout', prompt: expect.stringContaining('A faster checkout') }))
  })

  it('leaves the example tour on the welcome after «Done»', async () => {
    const user = userEvent.setup()
    fetches()
    render(<App />)
    await emit(makeSnapshot(makeRepo([makeTask({ id: 'build', status: 'running' }), makeTask({ id: 'review', status: 'in_review' })], [], { hasPlan: true, example: true, planId: 'orchestra-example' })))
    for (let step = 0; step < 3; step++) await user.click(screen.getByRole('button', { name: 'Next' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(localStorage.getItem(TOUR_KEY)).toBe('1')
    expect(screen.queryByRole('dialog', { name: 'Orchestrator' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'How to start' })).toBeTruthy()
    // Moving on — here, to Review — leaves the welcome.
    await user.click(screen.getByRole('radio', { name: 'Review' }))
    expect(screen.queryByRole('heading', { name: 'How to start' })).toBeNull()
  })
})
