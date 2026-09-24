// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel, primaryAction } from '../../src/client/panel/task-panel.js'
import { inboxItems } from '../../src/client/sidebar-model.js'
import { nowPhrase, taskEssence } from '../../src/client/summary.js'
import { needsYou } from '../../src/client/views/review-model.js'
import { workColumns } from '../../src/client/views/work.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeSnapshot, makeTask } from './helpers.js'

// w1d (B17): accepted is not merged. The panel says what to do instead of «no action needed», a dependent says it
// waits for the merge, and every «Needs you» surface lists the accepted-unmerged task.

const commands = ['git -C /repo merge --no-ff orch/a-a']
const accepted = makeTask({ id: 'a', title: 'Extract API', status: 'accepted', unmerged: true, branch: 'orch/a-a', acceptedAt: '2026-09-22T11:00:00Z', runs: 1 })
const waiting = makeTask({ id: 'g', title: 'Document API', status: 'blocked', deps: ['a'], blockedBy: ['a'], waitingMerge: ['a'] })

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

describe('accepted, not merged', () => {
  it('the panel names the merge and its exact commands instead of «no action needed»', async () => {
    expect(primaryAction(accepted)).toBe('merge')
    expect(primaryAction({ ...accepted, unmerged: undefined })).toBe('none')
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: 'main', branch: 'orch/a-a', path: '/repo-orch-a', commands } })) : jsonOk({ candidates: [] })))
    render(<TaskPanel repo={makeRepo([accepted, waiting])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByText('Accepted, not merged into main yet.')).toBeTruthy())
    expect(screen.getByText(commands[0]!)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy commands' })).toBeTruthy()
    expect(screen.queryByText(/no action needed/)).toBeNull()
  })

  it('says it in Russian too', async () => {
    setLang('ru')
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: 'main', branch: 'orch/a-a', path: '/repo-orch-a', commands } })) : jsonOk({ candidates: [] })))
    render(<TaskPanel repo={makeRepo([accepted])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByText('Принята, ещё не слита в main.')).toBeTruthy())
    expect(nowPhrase(accepted, [])).toMatchObject({ text: 'Принята — ещё не слита в базовую ветку.', tone: 'warn' })
    expect(taskEssence(waiting)).toBe('ждёт слияния a')
  })

  it('a merged task is done; a dependent says it waits for the merge, not for work', () => {
    expect(nowPhrase(accepted, [])).toMatchObject({ text: 'Accepted — not merged into the base branch yet.', tone: 'warn' })
    expect(nowPhrase(waiting, [])).toMatchObject({ text: 'Waiting for a to be merged.', hint: expect.stringContaining('not in the base branch yet') })
    expect(nowPhrase({ ...waiting, deps: ['a', 'b'], blockedBy: ['a', 'b'] }, []).text).toBe('Waiting on: b. · Waiting for a to be merged.')
    expect(taskEssence(waiting)).toBe('waiting for a to be merged')
    expect(taskEssence(accepted)).toBe('accepted, not merged')
  })

  it('Needs you, Work and Review list the task', () => {
    const repo = makeRepo([accepted, waiting], [], { planId: 'main' })
    expect(inboxItems(makeSnapshot(repo)).map((item) => [item.kind, item.id, item.hint])).toEqual([['unmerged', 'a', commands[0]]])
    expect(workColumns(repo).needsYou.map((task) => task.id)).toEqual(['a'])
    expect(needsYou(repo).unmerged.map((task) => task.id)).toEqual(['a'])
  })
})
