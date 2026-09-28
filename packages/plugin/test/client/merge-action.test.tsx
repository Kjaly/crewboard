// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../src/client/i18n.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { ensureStyles } from '../../src/client/styles.js'
import { installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

// mg1 (B18): Merge where the panel showed only the commands; conflicts named before acceptance with a ready Send back.

const commands = ['git -C /repo merge --no-ff orch/a-a']
const accepted = makeTask({ id: 'a', title: 'Extract API', status: 'accepted', unmerged: true, branch: 'orch/a-a', runs: 1 })
const inReview = makeTask({ id: 'b', title: 'Wire API', status: 'in_review', runs: 1, conflicts: [{ with: 'base', into: 'main', paths: ['src/a.ts'] }, { with: 'task', taskId: 'c', paths: ['src/b.ts'], into: 'main' }] })

beforeEach(() => {
  setLang('en')
  localStorage.clear()
})
afterEach(cleanup)

describe('merge from the panel', () => {
  it('Merge and Squash and merge post the strategy; the result is said in the panel', async () => {
    const calls = installFetch((url) => url.includes('/api/merge')
      ? jsonOk({ task: 'a', into: 'main', strategy: 'squash', commit: '0123456789abcdef', copy: 'removed' })
      : url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: 'main', branch: 'orch/a-a', path: '/repo-orch-a', commands } })) : jsonOk({ candidates: [] }))
    render(<TaskPanel repo={makeRepo([accepted])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
    await waitFor(() => expect(screen.getByText(commands[0]!)).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Merge' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Squash and merge' }))
    await waitFor(() => expect(screen.getByText('Merged into main: 0123456789ab. The worktree was removed.')).toBeTruthy())
    expect(calls.find((call) => call.url.includes('/api/merge'))?.body).toMatchObject({ task: 'a', strategy: 'squash' })
  })

  it('shows the refusal text the host sends', async () => {
    installFetch((url) => url.includes('/api/merge')
      ? new Response(JSON.stringify({ ok: false, error: 'conflicts', message: 'Merging task a into main would conflict in 1 files: src/a.ts.' }), { status: 409, headers: { 'content-type': 'application/json' } })
      : url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: 'main', branch: 'orch/a-a', path: '/repo-orch-a', commands } })) : jsonOk({ candidates: [] }))
    render(<TaskPanel repo={makeRepo([accepted])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(screen.getByText(/would conflict in 1 files: src\/a\.ts/)).toBeTruthy())
  })
})

describe('conflicts before acceptance', () => {
  it('names the conflicts in review and fills Send back with the ready text', async () => {
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'b', status: 'in_review' })) : jsonOk({ candidates: [] })))
    render(<TaskPanel repo={makeRepo([inReview])} task={inReview} attention={[]} onSelect={() => {}} density="overview" />)
    expect(await screen.findByText('conflicts with main in src/a.ts')).toBeTruthy()
    expect(screen.getByText('conflicts with task c in src/b.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Send back with this text' }))
    const field = screen.getByRole('textbox', { name: /reason/i }) as HTMLTextAreaElement
    expect(field.value).toBe('Bring the branch up to date with main: it conflicts with main in src/a.ts; it conflicts with task c in src/b.ts. Merge main into the branch (or rebase onto it), resolve the conflicts, run the checks again and report.')
  })
})

// bx1: jsdom lays nothing out, so the row's layout is held by its markup and its style rules; the stand screenshots
// (docs/tmp/2026.09.25_bx1-panel-actions_deviations.md) show the rendered rows at 260 and 420 px.
describe('the action row never overlaps (bx1)', () => {
  it('keeps the merge lead out of the button row: buttons wrap, the words go under them', async () => {
    installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a', status: 'accepted', merge: { into: 'main', branch: 'orch/a-a', path: '/repo-orch-a', commands } })) : jsonOk({ candidates: [] })))
    const { container } = render(<TaskPanel repo={makeRepo([accepted])} task={accepted} attention={[]} onSelect={() => {}} density="overview" />)
    const lead = await screen.findByText('Accepted, not merged into main yet.')
    const row = container.querySelector('.orc-sec--actions > .orc-actions')!
    expect(row.contains(lead)).toBe(false)
    expect([...row.children].map((el) => [el.tagName, el.className, el.textContent])).toEqual([
      ['BUTTON', 'orc-btn', 'Merge'],
      ['DETAILS', 'orc-early', 'Other merge optionsSquash and mergeMark as merged…'],
    ])
  })

  it('lets the panel rows wrap instead of squeezing their buttons', () => {
    ensureStyles()
    const css = document.querySelector('style[data-orchestra]')?.textContent ?? ''
    const panelRules = css.split('\n').filter((line) => line.startsWith('.orc-panel .orc-actions'))
    expect(panelRules.length).toBeGreaterThan(0)
    for (const rule of panelRules) expect(rule).not.toMatch(/flex-wrap:nowrap|white-space:nowrap/)
    expect(css).toContain('.orc-panel .orc-actions>.orc-meta,.orc-panel .orc-actions>code{flex:1 0 100%')
    // The owner's host puts ellipsis on buttons: the panel's button rule overrides it, so labels stay whole.
    expect(css).toContain('.orc-panel .orc-actions>.orc-btn{flex:0 1 auto;max-width:100%;overflow:visible;text-overflow:clip;white-space:normal}')
  })
})
