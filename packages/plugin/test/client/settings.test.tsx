// @vitest-environment jsdom
import { setLang } from '../../src/client/i18n.js'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskPanel } from '../../src/client/panel/task-panel.js'
import { OrchestraSettings } from '../../src/client/settings.js'
import type { OrchestraRepoSnapshot, Routing, SubscriptionCli, WorkersInfo } from '../../src/shared/types.js'
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
    { id: 'dsh/deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', provider: 'DeepSeek', billing: 'API', main: true, usedIn: [{ class: 'code', position: 1 }, { class: 'research', position: 2 }], section: 'dsh', transport: 'dsh', model: 'deepseek-flash', dsh: { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash' } },
    { id: 'claude/opus', label: 'Claude Opus 5', provider: 'Claude', billing: 'подписка', main: true, usedIn: [], section: 'subscription', cli: 'claude', transport: 'claude-cli', model: 'opus' },
    { id: 'claude-code', label: 'Claude Sonnet 5 · high', name: 'Claude Sonnet 5', provider: 'Claude', billing: 'подписка', main: true, usedIn: [], section: 'subscription', cli: 'claude', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'codex/gpt-5.6-sol', label: 'Codex GPT-5.6 Sol', provider: 'Codex', billing: 'подписка', main: true, usedIn: [{ class: 'design', position: 2 }], section: 'subscription', cli: 'codex', transport: 'codex-cli', model: 'gpt-5.6-sol' },
    // The saved profile `codex` folds onto its direct twin: the surviving row is `codex/gpt-6-astra`.
    { id: 'codex/gpt-6-astra', label: 'Codex GPT-6 Astra', provider: 'Codex', billing: 'подписка', main: true, usedIn: [{ class: 'review', position: 1 }], section: 'subscription', cli: 'codex', transport: 'codex-cli', model: 'gpt-6-astra' },
    {
      id: 'devin',
      label: 'Devin SWE-2',
      provider: 'Devin',
      billing: 'промо',
      main: true,
      section: 'subscription',
      cli: 'devin',
      transport: 'devin-acp',
      usedIn: [
        { class: 'code', position: 2 },
        { class: 'design', position: 1 },
        { class: 'review', position: 2 },
        { class: 'research', position: 1 },
      ],
    },
    // «Other / imported» (wo1): an older tool's Gemini CLI profile, a copy of claude-code, an id nothing defines.
    { id: 'gemini-cli', label: 'Gemini', provider: 'Другие', billing: 'подписка', main: false, usedIn: [], section: 'other', other: 'imported', transport: 'gemini-cli', model: 'gemini-3.1-pro-preview' },
    { id: 'claude-sonnet', label: 'Claude Sonnet 5 · high', name: 'Claude Sonnet 5', provider: 'Claude', billing: 'подписка', main: false, usedIn: [], section: 'other', other: 'duplicate', duplicateOf: 'claude-code', transport: 'claude-cli', model: 'claude-sonnet-5', effort: 'high' },
    { id: 'codex-reserve', label: 'Codex Reserve', provider: 'Другие', billing: 'другое', main: false, usedIn: [], section: 'other', other: 'stale' },
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

/** `info` as declared: the tests that mount `info` itself change it as they go. */
const pristine = structuredClone(info)

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
    if (url.includes('/api/worker-check')) {
      const state = access[(init.body as { kind: string }).kind] ?? 'signed'
      // 'unconfirmed': the check passes (preflight must not block) but still carries a fix hint — Gemini's
      // keychain-only sign-in — the shape preflight emits when no credential store is readable.
      const auth = state === 'unconfirmed' ? { name: 'auth', ok: true, detail: 'вход не подтверждён', fix: 'войти внутри `gemini`' } : { name: 'auth', ok: state === 'signed', detail: 'вход выполнен' }
      return jsonOk({ agent: 'claude', ok: state === 'signed' || state === 'unconfirmed', checks: [{ name: 'binary', ok: state !== 'missing', detail: 'доступен' }, ...(state === 'missing' ? [] : [auth])] })
    }
    if (url.includes('/api/worker-adopt')) {
      const id = (init.body as { id: string }).id
      data.workers = data.workers.map((w) => (w.id === id ? { ...w, section: 'subscription', cli: 'gemini', main: true, other: undefined } : w))
      return jsonOk({ adopted: id })
    }
    if (url.includes('/api/worker-forget')) {
      const id = (init.body as { id: string }).id
      data.workers = data.workers.filter((w) => w.id !== id)
      return jsonOk({ routing: false, presets: [] })
    }
    if (url.includes('/api/worker-models')) return jsonOk({ kind: 'codex', source: 'cli', models: [{ model: 'gpt-6-astra', label: 'Codex GPT-6-Astra', efforts: ['low', 'high'] }, { model: 'gpt-5.6-sol', label: 'Codex GPT-5.6-Sol', efforts: ['medium', 'high'] }] })
    if (url.includes('/api/worker-add-models')) return jsonOk({ added: ['codex/gpt-6-astra-high'], existing: ['codex/gpt-6-astra-low'] })
    if (url.includes('/api/worker-save')) {
      const entry = (init.body as { entry: typeof data.registry[number] }).entry
      data.registry = [...data.registry.filter((w) => w.id !== entry.id), entry]
      const before = data.workers.find((w) => w.id === entry.id)
      data.workers = [...data.workers.filter((w) => w.id !== entry.id), { ...before, id: entry.id, label: entry.label, name: entry.label, provider: entry.kind === 'dsh' ? 'DeepSeek' : entry.kind === 'claude' ? 'Claude' : entry.kind === 'codex' ? 'Codex' : 'Devin', billing: entry.billing as 'API' | 'подписка' | 'промо', main: true, usedIn: [], section: entry.kind === 'dsh' ? 'dsh' : 'subscription', ...(entry.kind === 'dsh' ? {} : { cli: entry.kind as 'claude' | 'codex' | 'devin' }) }]
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

/** What the next CLI access checks say, by CLI; unlisted CLIs are signed in. */
let access: Record<string, 'signed' | 'signin' | 'missing' | 'unconfirmed'> = {}
const posts = (name: string) => calls.filter((c) => c.method === 'POST' && c.url.includes(`/api/${name}`))
const savedRouting = () => (posts('workers-save').at(-1)!.body as { repo: string; routing: Routing }).routing

afterEach(() => cleanup())
beforeEach(() => {
  setLang('ru')
  calls = []
  access = {}
  localStorage.clear()
})

/** wo2: provider blocks whose models nothing uses start folded; «Expand all» opens every block of both sections. */
async function expandAll() {
  const buttons = await screen.findAllByRole('button', { name: 'Развернуть все' })
  for (const button of buttons) fireEvent.click(button)
}

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
  it('adds a Codex worker through worker-save without checking the typed model on open', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await screen.findByRole('button', { name: '+ Добавить воркера' })
    // wo1: the CLI blocks check their CLI (no model); the form checks a typed model only on request.
    await waitFor(() => expect(posts('worker-check')).toHaveLength(3))
    expect(posts('worker-check').every((call) => (call.body as { model: string }).model === '')).toBe(true)
    await user.click(screen.getByRole('button', { name: '+ Добавить воркера' }))
    await user.selectOptions(screen.getByRole('combobox', { name: 'Тип воркера' }), 'codex')
    await user.type(screen.getByRole('textbox', { name: 'Идентификатор модели' }), 'gpt-7')
    await user.click(screen.getByRole('button', { name: 'Добавить' }))
    await waitFor(() => expect(posts('worker-save')).toHaveLength(1))
    expect(posts('worker-save')[0]?.body).toEqual({ repo: ROOT, entry: { id: 'codex/gpt-7', kind: 'codex', model: 'gpt-7', label: 'Codex gpt-7', billing: 'подписка' } })
    expect(posts('worker-check')).toHaveLength(3)
  })

  it('V-ef1/label V-wo1/efforts lists one model once with an effort chip and its own switch per effort, and keeps the effort when it is renamed', async () => {
    const user = userEvent.setup()
    const data = structuredClone(info)
    const sonnet = { kind: 'claude', model: 'claude-sonnet-4', label: 'Claude Sonnet 4', billing: 'подписка' }
    data.registry.push({ ...sonnet, id: 'claude/sonnet-4-high', effort: 'high' } as typeof data.registry[number], { ...sonnet, id: 'claude/sonnet-4-medium', effort: 'medium' } as typeof data.registry[number])
    // The host already names them with the effort; the registry row still carries the bare label the owner edits.
    const row = { provider: 'Claude', billing: 'подписка', main: true, usedIn: [], section: 'subscription', cli: 'claude', transport: 'claude-cli', model: 'claude-sonnet-4', name: 'Claude Sonnet 4' } as const
    data.workers.push({ ...row, id: 'claude/sonnet-4-high', label: 'Claude Sonnet 4 · high', effort: 'high', usedIn: [] }, { ...row, id: 'claude/sonnet-4-medium', label: 'Claude Sonnet 4 · medium', effort: 'medium', usedIn: [] })
    mountSettings(data)
    await expandAll()
    const efforts = await screen.findByRole('group', { name: 'Усилия Claude Sonnet 4' })
    const claude = screen.getByRole('region', { name: 'Claude' })
    expect(within(claude).getAllByText('Claude Sonnet 4')).toHaveLength(1)
    // Medium before high, each a worker with its own «Enabled» switch.
    expect(within(efforts).getAllByText(/^(high|medium)$/).map((chip) => chip.textContent)).toEqual(['medium', 'high'])
    expect(within(efforts).getByRole('switch', { name: 'Воркер claude/sonnet-4-high' })).toBeTruthy()
    expect(within(efforts).getByRole('switch', { name: 'Воркер claude/sonnet-4-medium' })).toBeTruthy()
    await user.click(within(efforts).getByRole('switch', { name: 'Воркер claude/sonnet-4-medium' }))
    await waitFor(() => expect(posts('workers-save')).toHaveLength(1), { timeout: 3000 })
    expect(Object.keys(savedRouting().disabled)).toEqual(['claude/sonnet-4-medium'])
    await user.click(screen.getByRole('button', { name: 'Действия: Claude Sonnet 4 · high' }))
    await user.click(screen.getByRole('button', { name: 'Переименовать' }))
    const field = screen.getByRole('textbox', { name: 'Новое имя' })
    expect((field as HTMLInputElement).value).toBe('Claude Sonnet 4')
    await user.clear(field)
    await user.type(field, 'Sonnet deep')
    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    await waitFor(() => expect(posts('worker-save')).toHaveLength(1))
    expect(posts('worker-save')[0]?.body).toMatchObject({ entry: { id: 'claude/sonnet-4-high', label: 'Sonnet deep', effort: 'high' } })
  })

  it('warns which classes use a worker before deleting it', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await user.click(await screen.findByRole('button', { name: 'Действия: Devin SWE-2' }))
    await user.click(screen.getByRole('button', { name: 'Убрать' }))
    expect(posts('worker-delete')).toHaveLength(0)
    expect(screen.getByText(/Он стоит в списках: маршрутизация · код №2, маршрутизация · дизайн №1, маршрутизация · ревью №2, маршрутизация · исследование №1/)).toBeTruthy()
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

  it('V-pv1/catalog says dsh models are not listed when dsh shares no catalog, and the form adds only subscription CLIs', async () => {
    const user = userEvent.setup()
    const data = structuredClone(info)
    data.catalog = null
    mountSettings(data)
    expect(await screen.findByText('Модели dsh не показаны: этот dsh не отдаёт плагинам свой каталог моделей.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: '+ Добавить воркера' }))
    const type = screen.getByRole('combobox', { name: 'Тип воркера' })
    // rb1: every CLI Crewboard can run is a pickable kind — the form no longer hides OpenCode/Cursor/Gemini/Grok.
    expect(within(type).getAllByRole('option').map((o) => (o as HTMLOptionElement).value)).toEqual(['claude', 'codex', 'devin', 'opencode', 'cursor', 'gemini', 'grok'])
  })

  it('V-wo1/access checks each CLI once on open and again on «Check access»', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await expandAll()
    const claude = await screen.findByRole('region', { name: 'Claude' })
    await waitFor(() => expect(posts('worker-check').map((call) => (call.body as { kind: string }).kind)).toEqual(['claude', 'codex', 'devin']))
    expect(within(claude).getByText('claude auth login')).toBeTruthy()
    expect(await within(claude).findByText('вход выполнен')).toBeTruthy()
    await user.click(within(claude).getByRole('button', { name: 'Проверить доступ' }))
    await waitFor(() => expect(posts('worker-check')).toHaveLength(4))
    expect(posts('worker-check')[3]?.body).toEqual({ repo: ROOT, kind: 'claude', model: '' })
  })

  it('V-wo1/signed-out a CLI without sign-in shows its status and action but no model table', async () => {
    access = { claude: 'signin', codex: 'missing' }
    mountSettings(structuredClone(info))
    const claude = await screen.findByRole('region', { name: 'Claude' })
    expect(await within(claude).findByText('нужен вход')).toBeTruthy()
    expect(within(claude).queryByRole('switch')).toBeNull()
    expect(within(claude).queryByRole('list')).toBeNull()
    expect(within(claude).queryByRole('button', { name: 'Добавить модели' })).toBeNull()
    expect(within(claude).getByRole('button', { name: 'Проверить доступ' })).toBeTruthy()
    const codex = screen.getByRole('region', { name: 'Codex' })
    expect(await within(codex).findByText('не установлен')).toBeTruthy()
    expect(within(codex).queryByRole('switch')).toBeNull()
    // Devin is signed in: its model stays listed.
    expect(within(screen.getByRole('region', { name: 'Devin' })).getByRole('switch', { name: 'Воркер devin' })).toBeTruthy()
  })

  it('V-rb1/unconfirmed a passed-but-unverifiable sign-in shows «unconfirmed», not «signed in», and keeps its models listed', async () => {
    access = { gemini: 'unconfirmed' }
    const data = structuredClone(info)
    // A subscription-section Gemini worker puts its CLI block on the page and into the mount-time check.
    data.workers.push({ id: 'gemini/pro', label: 'Gemini pro', provider: 'Другие', billing: 'подписка', main: true, usedIn: [], section: 'subscription', cli: 'gemini', transport: 'gemini-cli', model: 'pro' })
    mountSettings(data)
    const gemini = await screen.findByRole('region', { name: 'Gemini CLI' })
    expect(await within(gemini).findByText('установлен · вход не подтверждён')).toBeTruthy()
    expect(within(gemini).queryByText('вход выполнен')).toBeNull()
    // Not «signed in»: the block keeps «Check access» rather than offering «Add models».
    expect(within(gemini).queryByRole('button', { name: 'Добавить модели' })).toBeNull()
    expect(within(gemini).getByRole('button', { name: 'Проверить доступ' })).toBeTruthy()
    await expandAll()
    expect(within(gemini).getByText('Gemini pro')).toBeTruthy()
  })

  it('saves a renamed worker through worker-save', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await expandAll()
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
    await expandAll()
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
    await expandAll()
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
    expect(within(codex).getByText('маршрутизация · ревью №1')).toBeTruthy()
  })

  it('V-wo1/other keeps «Other / imported» collapsed, and its count is its entries', async () => {
    const user = userEvent.setup()
    mountSettings()
    const other = await screen.findByRole('region', { name: 'Другое / импортированное · 3' })
    expect(within(other).getByText('Появилось само при подключении CLI или dsh. Не требуется для работы — можно оставить свёрнутым.')).toBeTruthy()
    const toggle = within(other).getByRole('button', { name: 'Другое / импортированное · 3' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(within(other).queryByRole('list')).toBeNull()
    await user.click(toggle)
    // One duplicate group, one imported profile, one stale id.
    expect(within(within(other).getByRole('list')).getAllByRole('listitem')).toHaveLength(3)
    expect(within(other).getByRole('group', { name: /Claude Sonnet 5 · high — копий: 2/ })).toBeTruthy()
    expect(within(other).getByRole('button', { name: 'Добавить как воркер' })).toBeTruthy()
    expect(within(other).getByText('на этой машине этот id ничем не задан')).toBeTruthy()
  })

  it('shows where each worker is used in the routing as chips', async () => {
    mountSettings()
    await expandAll()
    const devin = (await screen.findByRole('switch', { name: 'Воркер devin' })).closest('li')!
    expect(within(devin).getAllByRole('button', { name: /^Открыть / }).map((chip) => chip.textContent)).toEqual(['маршрутизация · код №2', 'маршрутизация · дизайн №1', 'маршрутизация · ревью №2', 'маршрутизация · исследование №1'])
    // The design class lists the saved id `codex-gpt-5.6-sol`; its direct row claims the spot.
    const sol = screen.getByRole('switch', { name: 'Воркер codex/gpt-5.6-sol' }).closest('li')!
    expect(within(sol).getByRole('button', { name: 'Открыть маршрутизация · дизайн №2' })).toBeTruthy()
    expect(within(screen.getByRole('switch', { name: 'Воркер claude/opus' }).closest('li')!).getByText('не используется')).toBeTruthy()
  })

  it('V-wo1/used-in a chip opens its preset and brings the class list into view', async () => {
    const user = userEvent.setup()
    const claude = { id: 'claude', label: 'Claude', routing: { code: ['claude/opus'], design: [], review: [], research: [] } }
    mountSettings(structuredClone(info), [claude])
    const opus = (await screen.findByRole('switch', { name: 'Воркер claude/opus' })).closest('li')!
    await user.click(within(opus).getByRole('button', { name: 'Открыть Claude · код №1' }))
    const code = await screen.findAllByRole('region', { name: 'По готовому коду' })
    expect(code).toHaveLength(1)
    await waitFor(() => expect(document.activeElement).toBe(code[0]))
    expect(within(code[0]!).getByText('Claude Opus 5')).toBeTruthy()
  })

  it('V-wo1/unavailable a preset entry of a switched-off worker stays listed and links back to its row', async () => {
    const user = userEvent.setup()
    const data = structuredClone(info)
    data.routing.disabled = { devin: 'нет лимитов' }
    mountSettings(data)
    const presets = await screen.findByRole('region', { name: 'Пресеты' })
    await user.click(within(presets).getAllByRole('button', { name: 'Изменить' })[0]!)
    const cls = await screen.findByRole('region', { name: 'По готовому коду' })
    const link = within(cls).getByRole('button', { name: 'Недоступен на этой машине — показать воркера Devin SWE-2' })
    expect(link.textContent).toBe('недоступен на этой машине — нет лимитов')
    await user.click(link)
    await waitFor(() => expect(document.activeElement?.id).toBe('orc-worker-devin'))
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

describe('workers from dsh and subscriptions (pv1)', () => {
  const withDsh = () => {
    const data = structuredClone(info)
    data.workers = data.workers.map((w) => (w.id === 'dsh/deepseek-flash' ? { ...w, label: 'DeepSeek V4 Flash · через dsh', dsh: { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-flash' } } : w))
    data.workers.push(
      { id: 'dsh/deepseek-official/deepseek-v4-pro', label: 'DeepSeek V4 Pro · через dsh', provider: 'DeepSeek', billing: 'API', main: true, usedIn: [], section: 'dsh', transport: 'dsh', dsh: { provider: 'deepseek-official', providerName: 'DeepSeek', model: 'deepseek-v4-pro' } },
      { id: 'dsh/openrouter/qwen/qwen-4', label: 'Qwen 4 · через dsh', provider: 'Другие', billing: 'API', main: true, usedIn: [], section: 'dsh', transport: 'dsh', dsh: { provider: 'openrouter', providerName: 'OpenRouter', model: 'qwen/qwen-4' } },
      { id: 'dsh/openrouter/gone', label: 'gone · через dsh', provider: 'Другие', billing: 'API', main: true, usedIn: [], section: 'dsh', transport: 'dsh', dsh: { provider: 'openrouter', providerName: 'OpenRouter', model: 'gone', missing: true } },
    )
    data.catalog = { groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] }, { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen/qwen-4', name: 'Qwen 4' }] }], failures: [] }
    return data
  }

  it('V-pv1/catalog groups every dsh model by its dsh provider and marks one dsh no longer lists', async () => {
    mountSettings(withDsh())
    await expandAll()
    const deepseek = await screen.findByRole('region', { name: 'DeepSeek · через dsh' })
    expect(within(deepseek).getByText('DeepSeek V4 Flash · через dsh')).toBeTruthy()
    expect(within(deepseek).getByRole('switch', { name: 'Воркер dsh/deepseek-official/deepseek-v4-pro' })).toBeTruthy()
    const openrouter = screen.getByRole('region', { name: 'OpenRouter · через dsh' })
    expect(within(openrouter).getByText('Qwen 4 · через dsh')).toBeTruthy()
    // V-wo1/blocked: a model dsh no longer lists is blocked, and its switch cannot be turned on.
    expect(within(openrouter).getByText('Заблокирован в dsh')).toBeTruthy()
    const gone = within(openrouter).getByRole('switch', { name: 'Воркер dsh/openrouter/gone' })
    expect(gone.hasAttribute('disabled')).toBe(true)
    expect(gone.getAttribute('aria-checked')).toBe('false')
    // The dsh rows sit only in «Via dsh (API)», under its keys hint.
    const dsh = screen.getByRole('region', { name: 'Через dsh (API)' })
    expect(within(dsh).getByText(/Ключи и модели — в dsh\./)).toBeTruthy()
    expect(within(dsh).getByRole('button', { name: 'Открыть настройки dsh' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Подписки' })).queryByText(/через dsh/)).toBeNull()
  })

  it('V-pv1/used-in counts the routing and every saved preset', async () => {
    const claude = { id: 'claude', label: 'Claude', routing: { code: ['claude/opus'], design: [], review: ['codex', 'claude/opus'], research: [] } }
    mountSettings(withDsh(), [claude])
    const chips = (id: string) => within(screen.getByRole('switch', { name: `Воркер ${id}` }).closest('li')!).getAllByRole('button', { name: /^Открыть / }).map((chip) => chip.textContent)
    await screen.findByRole('switch', { name: 'Воркер claude/opus' })
    expect(chips('claude/opus')).toEqual(['Claude · код №1', 'Claude · ревью №2'])
    expect(chips('codex/gpt-6-astra')).toEqual(['маршрутизация · ревью №1', 'Claude · ревью №1'])
  })

  it('V-pv1/add-models adds workers for the chosen models and efforts of a signed-in CLI', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    const family = await screen.findByRole('region', { name: 'Codex' })
    // «Add models» appears once the check confirms the CLI is signed in.
    await user.click(await within(family).findByRole('button', { name: 'Добавить модели' }))
    const form = await screen.findByRole('form', { name: 'Codex: какие модели добавить' })
    expect(posts('worker-models')[0]?.body).toEqual({ repo: ROOT, kind: 'codex' })
    const submit = within(form).getByRole('button', { name: /Добавить воркеров/ })
    expect(submit.hasAttribute('disabled')).toBe(true)
    await user.click(within(form).getByRole('checkbox', { name: /Codex GPT-6-Astra/ }))
    // Efforts follow the chosen models: GPT-6-Astra takes low and high.
    expect(within(form).queryByRole('checkbox', { name: 'medium' })).toBeNull()
    await user.click(within(form).getByRole('checkbox', { name: 'low' }))
    await user.click(within(form).getByRole('checkbox', { name: 'high' }))
    await user.click(within(form).getByRole('button', { name: 'Добавить воркеров: 2' }))
    await waitFor(() => expect(posts('worker-add-models')).toHaveLength(1))
    expect(posts('worker-add-models')[0]?.body).toEqual({ repo: ROOT, kind: 'codex', models: [{ model: 'gpt-6-astra', label: 'Codex GPT-6-Astra' }], efforts: ['low', 'high'] })
    expect(await screen.findByText('Добавлено: codex/gpt-6-astra-high; уже были: codex/gpt-6-astra-low')).toBeTruthy()
  })

  it('V-pv1/refresh reloads the list when the person comes back to the tab', async () => {
    mountSettings(withDsh())
    await screen.findByRole('region', { name: 'OpenRouter · через dsh' })
    const before = calls.filter((c) => c.url.includes('/api/workers?')).length
    document.dispatchEvent(new Event('visibilitychange'))
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/workers?')).length).toBe(before + 1))
  })
})

describe('three sections: subscriptions, via dsh, other (wo1)', () => {
  const sections = () => ['Подписки', 'Через dsh (API)', 'Другое / импортированное · 3'].map((name) => screen.getByRole('region', { name }))

  it('V-wo1/sections lists every worker in exactly one of three labelled sections', async () => {
    const user = userEvent.setup()
    mountSettings()
    await expandAll()
    await screen.findByRole('switch', { name: 'Воркер devin' })
    await user.click(screen.getByRole('button', { name: 'Другое / импортированное · 3' }))
    const [subscriptions, dsh, other] = sections()
    expect(subscriptions!.tagName).toBe('SECTION')
    // Each worker has one row anchor; a duplicate group only names the copy it keeps.
    const where = (id: string) => sections().filter((section) => [...section.querySelectorAll('[id]')].some((node) => node.id === `orc-worker-${id}`)).length
    for (const worker of info.workers) expect([worker.id, where(worker.id)]).toEqual([worker.id, 1])
    expect(within(subscriptions!).getByRole('switch', { name: 'Воркер claude/opus' })).toBeTruthy()
    expect(within(dsh!).getByRole('switch', { name: 'Воркер dsh/deepseek-flash' })).toBeTruthy()
    expect(within(other!).getByText('gemini-cli', { exact: false })).toBeTruthy()
    // The toggle column is «Enabled», not «Assign».
    expect(within(subscriptions!).getByText('Включён')).toBeTruthy()
  })

  it('V-wo1/new-user shows the three CLIs with Check access, the dsh empty hint and no «Other»', async () => {
    access = { claude: 'missing', codex: 'missing', devin: 'missing' }
    const data = structuredClone(info)
    data.workers = data.workers.filter((w) => w.section === 'subscription' && w.id.includes('/'))
    data.catalog = { groups: [], failures: [] }
    mountSettings(data)
    const subscriptions = await screen.findByRole('region', { name: 'Подписки' })
    for (const name of ['Claude', 'Codex', 'Devin']) {
      const cli = within(subscriptions).getByRole('region', { name })
      expect(await within(cli).findByText('не установлен')).toBeTruthy()
      expect(within(cli).getByRole('button', { name: 'Проверить доступ' })).toBeTruthy()
    }
    expect(within(subscriptions).queryAllByRole('switch')).toHaveLength(0)
    expect(within(screen.getByRole('region', { name: 'Через dsh (API)' })).getByText('Моделей нет. Настройте их в dsh → Settings → Models.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: /Другое \/ импортированное/ })).toBeNull()
  })

  it('V-wo1/new-user-dsh shows the built-in dsh route as one waiting line, not a blocked row, when dsh has no models', async () => {
    access = { claude: 'missing', codex: 'missing', devin: 'missing' }
    const data = structuredClone(info)
    data.workers = data.workers
      .filter((w) => (w.section === 'subscription' && w.id.includes('/')) || w.id === 'dsh/deepseek-flash')
      .map((w) => (w.dsh ? { ...w, dsh: { ...w.dsh, missing: true as const, builtin: 'DeepSeek V4 Flash' } } : w))
    data.catalog = { groups: [], failures: [] }
    mountSettings(data)
    const dsh = await screen.findByRole('region', { name: 'Через dsh (API)' })
    expect(within(dsh).getByText('Моделей нет. Настройте их в dsh → Settings → Models.')).toBeTruthy()
    expect(within(dsh).getByText('Встроенный маршрут DeepSeek V4 Flash ждёт ключа в dsh.')).toBeTruthy()
    expect(within(dsh).queryByText('Заблокирован в dsh')).toBeNull()
    expect(within(dsh).queryAllByRole('switch')).toHaveLength(0)
    expect(within(dsh).queryAllByRole('listitem')).toHaveLength(0)
  })

  it('V-wo1/duplicates keeps the chosen copy and removes the rest', async () => {
    const user = userEvent.setup()
    mountSettings()
    await user.click(await screen.findByRole('button', { name: 'Другое / импортированное · 3' }))
    const group = screen.getByRole('group', { name: /Claude Sonnet 5 · high — копий: 2/ })
    expect(within(group).getByText('Оставить один')).toBeTruthy()
    const radios = within(group).getAllByRole('radio')
    expect(radios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false])
    await user.click(radios[1]!)
    await user.click(screen.getByRole('button', { name: 'Убрать остальные' }))
    expect(posts('worker-delete')).toHaveLength(0)
    expect(screen.getByText('Убрать claude-code? Они уйдут и из всех списков, где стоят.')).toBeTruthy()
    await user.click(within(screen.getByRole('group', { name: /Подтверждение удаления/ })).getByRole('button', { name: 'Убрать остальные' }))
    await waitFor(() => expect(posts('worker-delete')).toHaveLength(1))
    expect(posts('worker-delete')[0]?.body).toEqual({ repo: ROOT, id: 'claude-code' })
  })

  it('V-wo1/imported adds an older tool\'s profile as a worker, and stale ids leave the lists', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(info))
    await user.click(await screen.findByRole('button', { name: 'Другое / импортированное · 3' }))
    await user.click(screen.getByRole('button', { name: 'Добавить как воркер' }))
    await waitFor(() => expect(posts('worker-adopt')).toHaveLength(1))
    expect(posts('worker-adopt')[0]?.body).toEqual({ repo: ROOT, id: 'gemini-cli' })
    // Adopted, it moves to its own CLI block; «Other» counts what is left.
    expect(await screen.findByRole('region', { name: 'Gemini CLI' })).toBeTruthy()
    const other = screen.getByRole('region', { name: 'Другое / импортированное · 2' })
    const stale = within(other).getByText('codex-reserve').closest('li')!
    await user.click(within(stale).getByRole('button', { name: 'Убрать' }))
    await waitFor(() => expect(posts('worker-forget')).toHaveLength(1))
    expect(posts('worker-forget')[0]?.body).toEqual({ repo: ROOT, id: 'codex-reserve' })
    expect(await screen.findByRole('region', { name: 'Другое / импортированное · 1' })).toBeTruthy()
  })

  it('V-wo1/copy uses the agreed English strings', async () => {
    setLang('en')
    const user = userEvent.setup()
    const data = structuredClone(info)
    data.catalog = { groups: [], failures: [] }
    mountSettings(data)
    await user.click(await screen.findByRole('button', { name: 'Other / imported · 3' }))
    for (const name of ['Subscriptions', 'Via dsh (API)', 'Other / imported · 3']) expect(screen.getByRole('region', { name })).toBeTruthy()
    for (const text of ['Picked up automatically from your CLIs or dsh. Not required — safe to leave collapsed.', 'No models yet. Configure them in dsh → Settings → Models.', 'Keep one', 'Remove the rest', 'Add as worker', 'Enabled']) expect(screen.getAllByText(text).length).toBeGreaterThan(0)
    expect(screen.getByText(/Keys and models live in dsh\./)).toBeTruthy()
  })
})

describe('provider blocks fold to one line (wo2)', () => {
  /** OpenCode: two models a routing still names — the host fixture says `runs: false`, as a CLI without a runner. */
  const withOpenCode = () => {
    const data = structuredClone(pristine)
    const row = { provider: 'Другие', billing: 'подписка', main: false, runs: false, section: 'subscription', cli: 'opencode', transport: 'opencode' } as const
    data.workers.push({ ...row, id: 'opencode-glm', label: 'GLM 5', name: 'GLM 5', model: 'zai/glm-5', usedIn: [] }, { ...row, id: 'opencode-kimi', label: 'Kimi K3', name: 'Kimi K3', model: 'moonshot/kimi-k3', usedIn: [] })
    data.routing = { ...data.routing, classes: { ...data.routing.classes, research: ['devin', 'opencode-glm'] } }
    return data
  }

  it('V-wo2/defaults a provider whose models are used starts open, others fold to one line with status, counts and the main action', async () => {
    mountSettings(structuredClone(pristine))
    const subscriptions = await screen.findByRole('region', { name: 'Подписки' })
    const claude = within(subscriptions).getByRole('region', { name: 'Claude' })
    const codex = within(subscriptions).getByRole('region', { name: 'Codex' })
    // Claude: nothing uses its two models — folded, one line.
    expect(within(claude).getByRole('button', { name: 'Claude' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(claude).queryByRole('switch')).toBeNull()
    expect(within(claude).queryByText('claude auth login')).toBeNull()
    expect(within(claude).getByText('2 модели · 0 в пресетах')).toBeTruthy()
    expect(await within(claude).findByText('вход выполнен')).toBeTruthy()
    // Signed in, the folded line keeps «Add models»; «Check access» waits in the open block.
    expect(within(claude).getByRole('button', { name: 'Добавить модели' })).toBeTruthy()
    expect(within(claude).queryByRole('button', { name: 'Проверить доступ' })).toBeNull()
    // Codex and Devin: the routing names their models — open.
    expect(within(codex).getByRole('button', { name: 'Codex' }).getAttribute('aria-expanded')).toBe('true')
    expect(within(codex).getByText('2 модели · 2 в пресетах')).toBeTruthy()
    expect(within(codex).getByRole('switch', { name: 'Воркер codex/gpt-6-astra' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'DeepSeek · через dsh' })).getByText('ключи в dsh')).toBeTruthy()
  })

  it('V-wo2/fold a click on the line opens a block, and «Expand all / Fold all» at the section head sets every block', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(pristine))
    const claude = await screen.findByRole('region', { name: 'Claude' })
    await user.click(within(claude).getByText('2 модели · 0 в пресетах'))
    expect(within(claude).getByRole('switch', { name: 'Воркер claude/opus' })).toBeTruthy()
    expect(within(claude).getByText('claude auth login')).toBeTruthy()
    // A button on the line does its own job and leaves the block as it is.
    await user.click(within(claude).getByRole('button', { name: 'Проверить доступ' }))
    expect(within(claude).getByRole('button', { name: 'Claude' }).getAttribute('aria-expanded')).toBe('true')
    await user.click(within(claude).getByRole('button', { name: 'Claude' }))
    expect(within(claude).queryByRole('switch')).toBeNull()
    const subscriptions = screen.getByRole('region', { name: 'Подписки' })
    await user.click(within(subscriptions).getByRole('button', { name: 'Развернуть все' }))
    for (const name of ['Claude', 'Codex', 'Devin']) expect(within(subscriptions).getByRole('button', { name }).getAttribute('aria-expanded')).toBe('true')
    await user.click(within(subscriptions).getByRole('button', { name: 'Свернуть все' }))
    expect(within(subscriptions).queryAllByRole('switch')).toHaveLength(0)
    expect(within(subscriptions).getByRole('button', { name: 'Развернуть все' })).toBeTruthy()
  })

  it('V-wo2/remembered the person\'s choice per provider outlives the screen, and the screen works without storage', async () => {
    const user = userEvent.setup()
    mountSettings(structuredClone(pristine))
    await user.click(within(await screen.findByRole('region', { name: 'Devin' })).getByRole('button', { name: 'Devin' }))
    await user.click(within(screen.getByRole('region', { name: 'Claude' })).getByRole('button', { name: 'Claude' }))
    cleanup()
    mountSettings(structuredClone(pristine))
    expect(within(await screen.findByRole('region', { name: 'Devin' })).queryByRole('switch')).toBeNull()
    expect(within(screen.getByRole('region', { name: 'Claude' })).getByRole('switch', { name: 'Воркер claude/opus' })).toBeTruthy()
    cleanup()
    // Storage that throws (a private window, blocked site data) leaves every block at its default.
    const original = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')!
    const originalSet = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')!
    Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: () => { throw new Error('blocked') } })
    Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: () => { throw new Error('blocked') } })
    try {
      mountSettings(structuredClone(pristine))
      const devin = await screen.findByRole('region', { name: 'Devin' })
      expect(within(devin).getByRole('switch', { name: 'Воркер devin' })).toBeTruthy()
      await user.click(within(devin).getByRole('button', { name: 'Devin' }))
      expect(within(devin).queryByRole('switch')).toBeNull()
    } finally {
      Object.defineProperty(Storage.prototype, 'getItem', original)
      Object.defineProperty(Storage.prototype, 'setItem', originalSet)
    }
  })

  it('V-wo2/no-runner a CLI Crewboard cannot run is folded, says so, has no toggles, keeps only Remove and is never offered in a picker', async () => {
    const user = userEvent.setup()
    mountSettings(withOpenCode())
    const opencode = await screen.findByRole('region', { name: 'OpenCode' })
    // Folded although the routing names one of its models.
    expect(within(opencode).getByRole('button', { name: 'OpenCode' }).getAttribute('aria-expanded')).toBe('false')
    expect(within(opencode).getByText('Crewboard пока не запускает задачи на OpenCode — модели показаны для справки')).toBeTruthy()
    expect(within(opencode).getByText('2 модели · 1 в пресетах')).toBeTruthy()
    await user.click(within(opencode).getByRole('button', { name: 'OpenCode' }))
    expect(within(opencode).getByText('GLM 5')).toBeTruthy()
    expect(within(opencode).queryAllByRole('switch')).toHaveLength(0)
    await user.click(within(opencode).getByRole('button', { name: 'Действия: GLM 5' }))
    const actions = opencode.querySelector('.orc-wrow__actions') as HTMLElement
    expect(within(actions).getAllByRole('button').map((button) => button.textContent)).toEqual(['Убрать'])
    // The default order: its entry is marked, and no picker offers OpenCode models.
    const presets = screen.getByRole('region', { name: 'Пресеты' })
    await user.click(within(presets).getAllByRole('button', { name: 'Изменить' })[0]!)
    const research = within(presets).getByRole('region', { name: 'Исследование' })
    expect(within(research).getByRole('button', { name: 'Недоступен на этой машине — показать воркера GLM 5' }).textContent).toBe('не запускается на этой машине')
    for (const cls of ['По готовому коду', 'Исследование']) {
      const picker = within(within(presets).getByRole('region', { name: cls })).getByRole('combobox')
      expect(within(picker).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).not.toEqual(expect.arrayContaining(['opencode-kimi']))
      expect(within(picker).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).not.toContain('opencode-glm')
    }
    // A saved preset's pickers skip them too.
    await user.click(within(presets).getByRole('button', { name: 'Новый пресет' }))
    await user.type(within(presets).getByRole('textbox', { name: 'Имя пресета' }), 'Research')
    await user.click(within(presets).getByRole('button', { name: 'Создать пресет' }))
    await waitFor(() => expect(posts('presets')).toHaveLength(1))
    const custom = await within(presets).findAllByRole('combobox', { name: 'Добавить воркера: По готовому коду' })
    for (const picker of custom) expect(within(picker).getAllByRole('option').map((option) => (option as HTMLOptionElement).value).filter((id) => id.startsWith('opencode'))).toEqual([])
  })

  it('V-wo2/generic «not run yet» follows the host\'s runner list, not the CLI\'s name', async () => {
    // Once a runner backend exists for OpenCode, the host lists it: its block runs like Claude's.
    const data = { ...withOpenCode(), runnableClis: ['claude', 'codex', 'devin', 'opencode'] as SubscriptionCli[] }
    data.workers = data.workers.map((w) => (w.cli === 'opencode' ? { ...w, main: true, runs: undefined } : w))
    mountSettings(data)
    const opencode = await screen.findByRole('region', { name: 'OpenCode' })
    expect(within(opencode).queryByText(/Crewboard пока не запускает задачи/)).toBeNull()
    // Used in the routing, it opens by default like any provider, with its switches.
    expect(within(opencode).getByRole('switch', { name: 'Воркер opencode-glm' })).toBeTruthy()
    cleanup()
    // And a CLI the host has no runner for says so, whatever it is called.
    const gemini = structuredClone(pristine)
    gemini.workers.push({ id: 'gemini-pro', label: 'Gemini Pro', name: 'Gemini Pro', provider: 'Другие', billing: 'подписка', main: false, runs: false, usedIn: [], section: 'subscription', cli: 'gemini', transport: 'gemini-cli', model: 'gemini-3.1-pro' })
    mountSettings({ ...gemini, runnableClis: ['claude', 'codex', 'devin', 'opencode'] })
    expect(await screen.findByText('Crewboard пока не запускает задачи на Gemini CLI — модели показаны для справки')).toBeTruthy()
  })

  it('V-wo2/copy uses the agreed English strings', async () => {
    setLang('en')
    mountSettings(withOpenCode())
    const opencode = await screen.findByRole('region', { name: 'OpenCode' })
    expect(within(opencode).getByText('Crewboard does not run tasks on OpenCode yet — models listed for reference')).toBeTruthy()
    expect(within(opencode).getByText('2 models · 1 in presets')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Subscriptions' })).getByRole('button', { name: 'Expand all' })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'DeepSeek · via dsh' })).getByText('keys in dsh')).toBeTruthy()
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
