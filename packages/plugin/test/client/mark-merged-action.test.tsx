// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

// mk1: Mark as merged… next to the merge commands; a detached base is named as the current commit of its checkout.

const commands = ['git -C /hub merge --no-ff orch/a-a']
const accepted = makeTask({ id: 'a', title: 'Extract API', status: 'accepted', unmerged: true, branch: 'orch/a-a', runs: 1 })
const sha = '0123456789abcdef0123456789abcdef01234567'

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

it('names a detached base, asks for a reason and posts it', async () => {
  const calls = installFetch((url) => url.includes('/api/mark-merged')
    ? jsonOk({ task: 'a', into: sha })
    : url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: sha, branch: 'orch/a-a', path: '/hub/.worktrees/a', commands, detached: { root: '/hub' } } })) : jsonOk({ candidates: [] }))
  render(<TaskPanel repo={makeRepo([accepted])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
  expect(await screen.findByText('Accepted, not merged into the current commit of /hub (detached) yet.')).toBeTruthy()
  expect(screen.queryByText(new RegExp(sha))).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Mark as merged…' }))
  const confirm = screen.getByRole('button', { name: 'Mark as merged' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: 'Why it counts as merged' }), { target: { value: 'carried into the hub by hand' } })
  fireEvent.click(confirm)
  await waitFor(() => expect(calls.find((call) => call.url.includes('/api/mark-merged'))?.body).toMatchObject({ task: 'a', reason: 'carried into the hub by hand' }))
})
