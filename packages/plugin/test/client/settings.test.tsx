// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { OrchestraSettings } from '../../src/client/settings.js'
import type { OrchestraRepoSnapshot, Routing, WorkersInfo } from '../../src/shared/types.js'
import { type FetchCall, ROOT, installFetch, jsonOk, makeDetail, makeRepo, makeTask } from './helpers.js'

beforeEach(() => setLang('ru'))

let calls: FetchCall[] = []

const routing: Routing = {
  classes: {
    code: ['dsh/deepseek-flash', 'devin'],
    design: ['devin', 'codex-gpt-5.6-sol'],
    review: ['codex', 'devin'],
    research: ['devin', 'dsh/deepseek-flash'],
  },
  disabled: {},
}

const info: WorkersInfo & { registry: Array<{ id: string; kind: string; model?: string; label: string; billing: string; note?: string }>; catalog: { groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; failures: [] } | null } = {
  routing,
  classes: [
    { id: 'code', label: 'По готовому коду' },
    { id: 'design', label: 'Проектирование и UI' },
    { id: 'review', label: 'Ревью' },
    { id: 'research', label: 'Исследование' },
  ],
  // `known` keeps every saved id for compatibility — including duplicates the host already folded away.
  known: ['dsh/deepseek-flash', 'devin', 'codex', 'codex-gpt-5.6-sol', 'claude/opus', 'claude-opus', 'gemini-cli'],
  workers: [
    { id: 'dsh/deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', provider: 'DeepSeek', billing: 'API', main: true, usedIn: [{ class: 'code', position: 1 }, { class: 'research', position: 2 }] },
    { id: 'claude/opus', label: 'Claude Opus 5', provider: 'Claude', billing: 'подписка', main: true, usedIn: [] },
    { id: 'codex/gpt-5.6-sol', label: 'Codex GPT-5.6 Sol', provider: 'Codex', billing: 'подписка', main: true, usedIn: [{ class: 'design', position: 2 }] },
    // The saved profile `codex` folds onto its direct twin: the surviving row is `codex/gpt-6-astra`.
    { id: 'codex/gpt-6-astra', label: 'Codex GPT-6 Astra', provider: 'Codex', billing: 'подписка', main: true, usedIn: [{ class: 'review', position: 1 }] },
    {
      id: 'devin',
      label: 'Devin SWE-2',
      provider: 'Devin',
      billing: 'промо',
      main: true,
      usedIn: [
        { class: 'code', position: 2 },
        { class: 'design', position: 1 },
        { class: 'review', position: 2 },
        { class: 'research', position: 1 },
      ],
    },
    { id: 'gemini-cli', label: 'Gemini', provider: 'Другие', billing: 'API', main: false, usedIn: [] },
    { id: 'claude-sonnet', label: 'Claude Sonnet 5', provider: 'Claude', billing: 'подписка', main: false, usedIn: [] },
  ],
  registry: [
    { id: 'dsh/deepseek-flash', kind: 'dsh', model: 'deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', billing: 'API' },
    { id: 'claude/opus', kind: 'claude', model: 'opus', label: 'Claude Opus 5', billing: 'подписка' },
    { id: 'codex/gpt-5.6-sol', kind: 'codex', model: 'gpt-5.6-sol', label: 'Codex GPT-5.6 Sol', billing: 'подписка' },
    { id: 'codex/gpt-6-astra', kind: 'codex', model: 'gpt-6-astra', label: 'Codex GPT-6 Astra', billing: 'подписка' },
    { id: 'devin', kind: 'devin', label: 'Devin SWE-2', billing: 'промо' },
  ],
  catalog: { groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash' }, { id: 'deepseek-v4', name: 'DeepSeek V4' }] }], failures: [] },
}

function mountSettings(data = info, initialPresets: Array<{ id: string; label: string; routing: Routing['classes'] }> = [], repoState: OrchestraRepoSnapshot = makeRepo([])) {
  let presets = initialPresets
  calls = installFetch((url, init) => {
    if (url.includes('/api/presets') && init.method === 'GET') return jsonOk({ presets, effectiveRouting: { preset: { id: 'all-workers', label: 'All workers', routing: data.routing.classes, builtin: true }, source: 'builtin', routing: data.routing.classes, dropped: [], disabled: {} } })
    if (url.includes('/api/presets') && init.method === 'POST') { presets = [...presets.filter((p) => p.id !== (init.body as { preset: typeof presets[number] }).preset.id), (init.body as { preset: typeof presets[number] }).preset]; return jsonOk(presets) }
    if (url.includes('/api/state')) return jsonOk({ generatedAt: '2026-09-22T12:00:00Z', repos: [repoState] })
    if (url.includes('/api/worktree-gc')) return jsonOk({ removed: ['a'], failed: [] })
    if (url.includes('/api/worktree-policy')) return jsonOk({ policy: (init.body as { policy: string }).policy })
    if (url.includes('/api/worktrees')) return jsonOk({ candidates: [
      { taskId: 'a', path: '/repo/.worktrees/a', branch: 'orc/a', sizeBytes: 2_000_000_000 },
      { taskId: 'b', path: '/repo/.worktrees/b', branch: 'orc/b', sizeBytes: 1_000_000_000, keep: 'dirty' },
    ], totalBytes: 3_000_000_000, policy: 'после приёмки' })
    if (url.includes('/api/workers-save')) return jsonOk(null)
    if (url.includes('/api/worker-check')) return jsonOk({ agent: 'claude', ok: true, checks: [{ name: 'binary', ok: true, detail: 'доступен' }, { name: 'auth', ok: true, detail: 'вход выполнен' }] })
    if (url.includes('/api/worker-save')) {
      const entry = (init.body as { entry: typeof data.registry[number] }).entry
      data.registry = [...data.registry.filter((w) => w.id !== entry.id), entry]
      data.workers = [...data.workers.filter((w) => w.id !== entry.id), { id: entry.id, label: entry.label, provider: entry.kind === 'dsh' ? 'DeepSeek' : entry.kind === 'claude' ? 'Claude' : entry.kind === 'codex' ? 'Codex' : 'Devin', billing: entry.billing as 'API' | 'подписка' | 'промо', main: true, usedIn: [] }]
      return jsonOk({ version: 1, workers: data.registry })
    }
    if (url.includes('/api/worker-delete')) {
      const id = (init.body as { id: string }).id
      data.registry = data.registry.filter((w) => w.id !== id)
      data.workers = data.workers.filter((w) => w.id !== id)
      return jsonOk({ removed: [id, ...(id === 'codex/gpt-6-astra' ? ['codex', 'codex-gpt-6-astra'] : [])], registry: data.registry })
    }
    if (url.includes('/api/workers')) return jsonOk(data)
    return jsonOk(null)
  })
  render(<OrchestraSettings />)
}

const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))
const savedRouting = () => (posts('workers-save').at(-1)!.body as { repo: string; routing: Routing }).routing

afterEach(() => cleanup())
beforeEach(() => {
  setLang('ru')
  calls = []
})

describe('worker presets', () => {
  it('shows a preset assignment before confirming deletion', async () => {
    const user = userEvent.setup()
    const preset = { id: 'claude', label: 'Claude', routing: structuredClone(routing.classes) }
    mountSettings(structuredClone(info), [preset], { ...makeRepo([]), effectiveRouting: { preset, source: 'repository', routing: preset.routing, dropped: [], disabled: {} } })
    const section = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(section).getByRole('button', { name: 'Убрать' }))
    expect(within(section).getAllByText('Репозиторий: repo')).toHaveLength(2)
    expect(posts('preset-delete')).toHaveLength(0)
  })
  it('creates a preset with editable class order', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const section = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(section).getByRole('button', { name: 'Новый пресет' }))
    await user.type(within(section).getByRole('textbox', { name: 'Имя пресета' }), 'Codex: Luna → Sol')
    await user.click(within(section).getByRole('button', { name: 'Создать пресет' }))
    await waitFor(() => expect(posts('presets')).toHaveLength(1))
    expect((posts('presets')[0]!.body as { preset: { label: string } }).preset.label).toBe('Codex: Luna → Sol')
    expect(within(section).getByText('По умолчанию — если другой пресет не выбран')).toBeTruthy()
    expect((posts('presets')[0]!.body as { preset: { routing: Routing['classes'] } }).preset.routing).toEqual(routing.classes)
    expect(screen.queryByRole('heading', { name: 'Порядок воркеров по классам задач' })).toBeNull()
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Добавить воркера: По готовому коду' }), 'claude/opus')
    await waitFor(() => expect(posts('presets')).toHaveLength(2))
  })
  it('edits the default order in the presets section', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const section = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(section).getByRole('button', { name: 'Изменить' }))
    const cls = within(section).getByRole('region', { name: 'По готовому коду' })
    await user.click(within(cls).getByRole('button', { name: 'Поднять devin' }))
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(savedRouting().classes.code[0]).toBe('devin')
    expect(posts('presets')).toHaveLength(0)
  })
})

describe('OrchestraSettings', () => {
  it('lists copy sizes and reasons, and confirms only eligible copies', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const section = await screen.findByRole('region', { name: 'Рабочие копии' })
    expect(await within(section).findByText('2 копии · 3,00 ГБ')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Показать' }))
    expect(within(section).getByText('есть незакоммиченные изменения')).toBeTruthy()
    expect(within(section).getByText('1,00 ГБ')).toBeTruthy()
    await user.click(within(section).getByRole('button', { name: 'Убрать лишние' }))
    expect(within(section).getByText('Убрать 1 копию · 2,00 ГБ?')).toBeTruthy()
    expect(posts('worktree-gc')).toHaveLength(0)
    await user.click(within(section).getByRole('button', { name: 'Убрать копии' }))
    await waitFor(() => expect(posts('worktree-gc')).toHaveLength(1))
    expect(posts('worktree-gc')[0]?.body).toEqual({ repo: ROOT, tasks: ['a'] })
  })

  it('saves the selected cleanup policy', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const section = await screen.findByRole('region', { name: 'Рабочие копии' })
    await within(section).findByText('2 копии · 3,00 ГБ')
    await user.selectOptions(within(section).getByRole('combobox', { name: 'Правило уборки' }), 'по команде')
    await waitFor(() => expect(posts('worktree-policy')).toHaveLength(1))
    expect(posts('worktree-policy')[0]?.body).toEqual({ repo: ROOT, policy: 'по команде' })
  })
  it('adds a Codex worker through worker-save without checking the CLI on open', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await screen.findByRole('button', { name: '+ Добавить воркера' })
    expect(posts('worker-check')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: '+ Добавить воркера' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Тип воркера' }), 'codex')
    await user.type(screen.getByRole('textbox', { name: 'Идентификатор модели' }), 'gpt-7')
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    await waitFor(() => expect(posts('worker-save')).toHaveLength(1))
    expect(posts('worker-save')[0]?.body).toEqual({ repo: ROOT, entry: { id: 'codex/gpt-7', kind: 'codex', model: 'gpt-7', label: 'Codex gpt-7', billing: 'подписка' } })
    expect(posts('worker-check')).toHaveLength(0)
  })

  it('warns which classes use a worker before deleting it', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await user.click(await screen.findByRole('button', { name: 'Действия: Devin SWE-2' }))
    await user.click(screen.getByRole('button', { name: 'Убрать' }))
    expect(posts('worker-delete')).toHaveLength(0)
    expect(screen.getByText(/Он стоит в списках: код №2 · дизайн №1 · ревью №2 · исследование №1/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Убрать воркера' }))
    await waitFor(() => expect(posts('worker-delete')).toHaveLength(1))
    expect(posts('worker-delete')[0]?.body).toEqual({ repo: ROOT, id: 'devin' })
  })

  it('removes saved aliases from routing when deleting a direct worker', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await user.click(await screen.findByRole('button', { name: 'Действия: Codex GPT-6 Astra' }))
    await user.click(screen.getByRole('button', { name: 'Убрать' }))
    await user.click(screen.getByRole('button', { name: 'Убрать воркера' }))
    await waitFor(() => expect(posts('worker-delete')).toHaveLength(1))
    expect(posts('workers-save')).toHaveLength(0)
    expect(await screen.findByText('Убрано: codex/gpt-6-astra, codex, codex-gpt-6-astra')).toBeTruthy()
  })

  it('points to dsh Models when the catalog is empty', async () => {
    const user = userEvent.setup()
    const data = structuredClone(info)
    data.catalog = null
    mountSettings(data)
    await user.click(await screen.findByRole('button', { name: '+ Добавить воркера' }))
    expect(screen.getByText('Настройте модели в Settings → Models.')).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Модель dsh' }).hasAttribute('disabled')).toBe(true)
  })

  it('runs CLI access checks only when requested', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const family = await screen.findByLabelText('Доступ к CLI')
    expect(posts('worker-check')).toHaveLength(0)
    await user.click(within(family).getAllByRole('button', { name: 'Проверить доступ' })[0]!)
    await waitFor(() => expect(posts('worker-check')).toHaveLength(1))
    expect(posts('worker-check')[0]?.body).toEqual({ repo: ROOT, kind: 'claude', model: '' })
  })

  it('saves a renamed worker through worker-save', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await user.click(await screen.findByRole('button', { name: 'Действия: Claude Opus 5' }))
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    const input = screen.getByRole('textbox', { name: 'Новое имя' })
    await user.clear(input)
    await user.type(input, 'Claude для ревью')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(posts('worker-save')).toHaveLength(1))
    expect((posts('worker-save')[0]!.body as { entry: { label: string } }).entry.label).toBe('Claude для ревью')
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Claude' })).getByText('Claude для ревью')).toBeTruthy())
  })
  it('switches a worker off and saves the reason in routing.disabled', async () => {
    const user = userEvent.setup()
    mountSettings()
    const toggle = await screen.findByRole('switch', { name: 'Воркер claude/opus' })
    await user.click(toggle)
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(savedRouting().disabled['claude/opus']).toBe('нет лимитов')
    expect((posts('workers-save')[0]!.body as { repo: string }).repo).toBe(ROOT)
  })

  it('moves a worker up inside its class and saves the new order', async () => {
    const user = userEvent.setup()
    mountSettings()
    const presets = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(presets).getAllByRole('button', { name: 'Изменить' })[0]!)
    const cls = await screen.findByRole('region', { name: 'По готовому коду' })
    await user.click(within(cls).getByRole('button', { name: 'Поднять devin' }))
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(savedRouting().classes.code).toEqual(['devin', 'dsh/deepseek-flash'])
    expect(savedRouting().classes.design).toEqual(routing.classes.design)
  })

  it('shows each saved alias only through its direct backend', async () => {
    mountSettings()
    await screen.findByRole('switch', { name: 'Воркер claude/opus' })
    // `claude-opus` is in `known` for compatibility but must not get a row of its own.
    expect(screen.queryByRole('switch', { name: 'Воркер claude-opus' })).toBeNull()
    expect(screen.queryByText('claude-opus')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByText('Claude Opus 5')).toBeTruthy()
    // `codex` folds into `codex/gpt-6-astra`: one row, labelled, with the review slot counted.
    expect(screen.queryByRole('switch', { name: 'Воркер codex' })).toBeNull()
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(within(codex).getAllByText('Codex GPT-6 Astra')).toHaveLength(1)
    expect(within(codex).getByRole('switch', { name: 'Воркер codex/gpt-6-astra' })).toBeTruthy()
    expect(within(codex).getByText('ревью №1')).toBeTruthy()
  })

  it('hides non-main saved profiles behind the disclosure', async () => {
    const user = userEvent.setup()
    mountSettings()
    await screen.findByRole('switch', { name: 'Воркер devin' })
    expect(screen.queryByRole('switch', { name: 'Воркер gemini-cli' })).toBeNull()
    await user.click(screen.getByRole('button', { name: /Ещё профили · 2/ }))
    expect(await screen.findByRole('switch', { name: 'Воркер gemini-cli' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Воркер claude-sonnet' })).toBeTruthy()
  })

  it('shows where each worker is used in the routing', async () => {
    mountSettings()
    await screen.findByRole('switch', { name: 'Воркер devin' })
    expect(screen.getByText('код №2 · дизайн №1 · ревью №2 · исследование №1')).toBeTruthy()
    // The design class lists the saved id `codex-gpt-5.6-sol`; its direct row claims the spot.
    expect(screen.getByText('дизайн №2')).toBeTruthy()
    expect(screen.getByText('не используется')).toBeTruthy()
  })

  it('reorders a worker by dragging its row and saves the new order', async () => {
    mountSettings()
    const presets = await screen.findByRole('region', { name: 'Пресеты' })
    fireEvent.click(within(presets).getAllByRole('button', { name: 'Изменить' })[0]!)
    const cls = await screen.findByRole('region', { name: 'По готовому коду' })
    const row = within(cls).getByRole('button', { name: 'Переставить DeepSeek V4 Flash (dsh)' }).closest('li')
    expect(row).toBeTruthy()
    fireEvent.pointerDown(row!, { clientY: 0 })
    fireEvent.pointerMove(window, { clientY: 40 })
    fireEvent.pointerUp(window, { clientY: 40 })
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(savedRouting().classes.code).toEqual(['devin', 'dsh/deepseek-flash'])
  })

  it('reorders a worker from the keyboard grip and announces the position', async () => {
    const user = userEvent.setup()
    mountSettings()
    const presets = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(presets).getAllByRole('button', { name: 'Изменить' })[0]!)
    const cls = await screen.findByRole('region', { name: 'По готовому коду' })
    const grip = within(cls).getByRole('button', { name: 'Переставить DeepSeek V4 Flash (dsh)' })
    grip.focus()
    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(savedRouting().classes.code).toEqual(['devin', 'dsh/deepseek-flash'])
    expect(within(cls).getByText('DeepSeek V4 Flash (dsh) — позиция 2 из 2')).toBeTruthy()
  })
})

describe('task panel launch', () => {
  function mountPanel(patch: Partial<ReturnType<typeof makeTask>> = {}) {
    const task = makeTask({ id: 'a', status: 'ready', ...patch })
    calls = installFetch((url) => (url.includes('/api/task') ? jsonOk(makeDetail({ id: 'a' })) : jsonOk(null)))
    render(<TaskPanel repo={makeRepo([task])} task={task} attention={[]} onSelect={() => {}} density="overview" />)
    return task
  }

  it('defaults to «Авто — по правилам» and launches without an agent', async () => {
    const user = userEvent.setup()
    mountPanel({ class: 'design' })
    const select = screen.getByRole('combobox', { name: 'Воркер' }) as HTMLSelectElement
    expect(select.value).toBe('auto')
    expect(within(select).getAllByRole('option')[0]?.textContent).toBe('Авто — по правилам')
    expect(screen.getAllByText(/Проектирование и UI/).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() => expect(posts('run')).toHaveLength(1))
    expect(posts('run')[0]?.body).toEqual({ repo: ROOT, task: 'a' })
  })

  it('still sends an explicitly picked worker', async () => {
    const user = userEvent.setup()
    mountPanel()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Воркер' }), 'devin')
    await user.click(screen.getByRole('button', { name: 'Запустить' }))
    await waitFor(() => expect(posts('run')).toHaveLength(1))
    expect(posts('run')[0]?.body).toEqual({ repo: ROOT, task: 'a', agent: 'devin' })
  })
})
