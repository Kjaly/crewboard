// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TaskSnapshot } from '../../src/shared/types.js'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { type FetchCall, ROOT, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

let calls: FetchCall[] = []

const WORKTREE = { path: '/Users/dev/projects/crewboard-orch-f3/wt/a', branch: 'orc/a' }
const CONTRACT = { path: 'plan/contracts/a.md', text: '# контракт', truncated: false }

function mount(task: TaskSnapshot, detail: Partial<ReturnType<typeof makeDetail>> = {}, postResult: (url: string) => unknown = () => jsonOk(null), copyOnDisk = true) {
  calls = installFetch((url) =>
    url.includes('/api/task') ? jsonOk(makeDetail({ id: task.id, ...detail })) : url.includes('/api/worktrees') ? jsonOk({ candidates: copyOnDisk && detail.worktree ? [{ taskId: task.id, ...detail.worktree, ...(task.status === 'running' ? { keep: 'running' } : {}) }] : [], totalBytes: 0, policy: 'после приёмки' }) : postResult(url),
  )
  const repo = makeRepo([task], [])
  render(<TaskPanel repo={repo} task={task} attention={[]} onSelect={() => {}} density="overview" />)
}

const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))
const workerSelect = () => screen.getByRole('combobox', { name: 'Воркер' }) as HTMLSelectElement

beforeEach(() => {
  setLang('ru')
  calls = []
})
afterEach(() => cleanup())

describe('run menu worker', () => {
  it('shows the provider mark and model in the panel header', () => {
    mount(makeTask({ id: 'a', worker: 'codex-gpt-6-sol' }))
    expect(screen.getByText('CX', { selector: '.orc-prov' })).toBeTruthy()
    expect(screen.getByText(/Codex GPT-6 Sol/, { selector: '.orc-panel__identity-name' })).toBeTruthy()
  })
  it('defaults to routing and offers the task worker mapped to a direct backend', () => {
    mount(makeTask({ id: 'a', status: 'ready', worker: 'claude-opus' }))
    expect(workerSelect().value).toBe('auto')
    expect([...workerSelect().options].map((o) => o.value)).toContain('claude/opus')
  })

  it('offers saved Claude profiles as direct claude/* backends', () => {
    mount(makeTask({ id: 'a', status: 'ready', worker: 'dsh' }))
    const options = [...workerSelect().options].map((o) => o.value)
    expect(options).toContain('claude/opus')
    expect(options).toContain('claude/fable')
    expect(options.some((o) => /^claude-/.test(o))).toBe(false)
  })

  it('keeps an unknown worker selectable and sends it in the run request', async () => {
    const user = userEvent.setup()
    mount(makeTask({ id: 'a', status: 'ready', worker: 'codex/gpt-5.6-sol' }), {}, () => jsonOk({ runId: 'run_1', agent: 'codex/gpt-5.6-sol', worktree: WORKTREE }))
    await user.selectOptions(workerSelect(), 'codex/gpt-5.6-sol')
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() => expect(posts('run')).toHaveLength(1))
    expect(posts('run')[0]?.body).toEqual({ repo: ROOT, task: 'a', agent: 'codex/gpt-5.6-sol' })
  })
})

describe('«Запуск» block', () => {
  it('shows the removed state for an accepted task whose copy is absent', async () => {
    mount(makeTask({ id: 'a', status: 'accepted' }), { worktree: WORKTREE }, undefined, false)
    expect(await screen.findByText('Копия убрана')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Убрать копию' })).toBeNull()
  })
  it('shows the removal action for an eligible copy and then the removed state', async () => {
    const user = userEvent.setup()
    mount(makeTask({ id: 'a', status: 'accepted' }), { worktree: WORKTREE }, (url) => url.includes('/api/worktree-gc') ? jsonOk({ removed: ['a'], failed: [] }) : jsonOk(null))
    const block = await screen.findByRole('group', { name: 'Запуск' })
    await screen.findByRole('button', { name: 'Убрать копию' })
    expect(block.querySelector('code[title]')?.getAttribute('title')).toBe(WORKTREE.path)
    await user.click(screen.getByRole('button', { name: 'Убрать копию' }))
    await waitFor(() => expect(posts('worktree-gc')[0]?.body).toEqual({ repo: ROOT, tasks: ['a'] }))
    expect(await screen.findByText('Копия убрана')).toBeTruthy()
  })

  it('shows why a copy stays and offers no removal', async () => {
    mount(makeTask({ id: 'a', status: 'running' }), { worktree: WORKTREE })
    await screen.findByRole('group', { name: 'Запуск' })
    expect(await screen.findByText('задача выполняется')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Убрать копию' })).toBeNull()
  })
  it('appears after a successful start: who, where, on which contract, since when', async () => {
    const user = userEvent.setup()
    mount(makeTask({ id: 'a', status: 'ready', worker: 'dsh' }), { contract: CONTRACT }, () =>
      jsonOk({ runId: 'run_1', agent: 'dsh', worktree: WORKTREE }),
    )
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    const block = await screen.findByRole('group', { name: 'Запуск' })
    expect(screen.getByText(/DeepSeek V4 Flash/, { selector: '.orc-panel__identity-name' })).toBeTruthy()
    expect(block.textContent).toContain('/wt/a')
    expect(block.textContent).toContain('orc/a')
    expect(screen.queryByRole('button', { name: /Открыть контракт/ })).toBeNull()
    expect(block.textContent).not.toContain('Лента ниже обновляется сама')
    const copy = block.querySelector('button[title]') as HTMLElement
    expect(copy.title).toBe(WORKTREE.path)
  })

  it('shows the worktree and keeps the contract in its tab', async () => {
    setLang('ru')
    const user = userEvent.setup()
    mount(makeTask({ id: 'a', status: 'running', worker: 'claude/fable', activeSince: new Date(Date.now() - 120_000).toISOString() }), {
      worktree: WORKTREE,
      contract: CONTRACT,
    })
    const block = await screen.findByRole('group', { name: 'Запуск' })
    expect(screen.getByText(/Claude Fable 5.1/, { selector: '.orc-panel__identity-name' })).toBeTruthy()
    expect(screen.getByText('· 2 мин')).toBeTruthy()
    expect(block.textContent).not.toContain('Claude Fable 5.1')
    await user.click(screen.getByRole('tab', { name: 'Контракт' }))
    expect(screen.getByRole('tab', { name: 'Контракт' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTitle(CONTRACT.path).textContent).toContain(CONTRACT.path)
  })

  it('keeps each run fact in one place and actions outside the scrolling feed', async () => {
    setLang('ru')
    mount(makeTask({ id: 'a', status: 'running', worker: 'claude/fable', activeSince: new Date(Date.now() - 120_000).toISOString() }), { worktree: WORKTREE, contract: CONTRACT })
    const panel = screen.getByRole('complementary', { name: 'Задача: Задача a' })
    await screen.findByRole('group', { name: 'Запуск' })
    expect(panel.querySelectorAll('.orc-panel__identity')).toHaveLength(1)
    expect(panel.querySelectorAll('.orc-foot')).toHaveLength(0)
    expect(panel.querySelectorAll('[title="' + WORKTREE.path + '"]')).toHaveLength(2)
    expect(panel.querySelector('.orc-panel__fixed')?.contains(screen.getByRole('button', { name: 'Поправить…' }))).toBe(true)
    expect(panel.querySelector('.orc-panel__scroll')?.contains(screen.getByRole('button', { name: 'Поправить…' }))).toBe(false)
    expect(panel.querySelectorAll('.orc-now')).toHaveLength(0)
  })
})
