import { olderConfigPath } from '@crewboard/core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, DEFAULT_ROUTING, initPlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes, resolvedWorkers } from '../src/host/actions.js'
import type { Native } from '../src/host/native.js'
import { OrchestraService } from '../src/host/service.js'

it('reads and saves the routing through the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-wr-'))
  const home = await mkdtemp(join(tmpdir(), 'orch-wr-home-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  const config = olderConfigPath({}, home)
  await writeFile(
    config,
    JSON.stringify({
      agents: {
        devin: { backend: 'devin-cli', model: 'swe-2-high', label: 'Devin SWE-2' },
        codex: { backend: 'codex-cli', model: 'gpt-6-astra', label: 'Codex GPT-6 Astra' },
        'claude-opus': { backend: 'claude-code', model: 'claude-opus-5', label: 'Claude Opus 5' },
        'codex-gpt-6-sol': { backend: 'codex-cli', model: 'gpt-6-sol' },
        'gemini-cli': { backend: 'gemini-cli', model: 'gemini-3.1-pro-preview', label: 'Gemini' },
      },
    }),
  )
  await initPlan(root, 'g')
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => new Date(), env: { HOME: home } })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home, now: () => new Date() })
  const call = async (method: string, url: string, body?: unknown) => {
    const route = routes.find((r) => r.path === url.split('?')[0])
    if (!route) throw new Error(`no route ${url}`)
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: { routing: typeof DEFAULT_ROUTING; classes: Array<{ id: string; label: string }>; known: string[]; workers: Array<{ id: string; label: string; provider: string; billing: string; main: boolean; usedIn: Array<{ class: string; position: number }>; section?: string; cli?: string; other?: string }>; registry: Array<{ id: string }>; catalog: null | { groups: unknown[]; failures: unknown[] }; removed?: string[] }; error?: string } }
  }
  const got = await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)
  expect(got.json.value?.routing).toEqual(DEFAULT_ROUTING)
  expect(got.json.value?.catalog).toBeNull()
  expect(got.json.value?.registry.map((w) => w.id)).toContain('claude/opus')
  expect(got.json.value?.classes.map((c) => c.id)).toEqual(['code', 'design', 'review', 'research'])
  expect(got.json.value?.known).toEqual(expect.arrayContaining(['devin', 'dsh/deepseek-flash', 'claude/opus']))
  const workers = got.json.value?.workers ?? []
  const byId = new Map(workers.map((w) => [w.id, w]))
  // The saved `claude-opus` profile is the same model as `claude/opus`: folded, with its label inherited.
  expect(byId.has('claude-opus')).toBe(false)
  // The API-only Claude route bills as API (not a subscription); the section still follows its transport.
  expect(byId.get('claude/opus')).toMatchObject({ label: 'Claude Opus 5', provider: 'Claude', billing: 'API', main: true })
  // `codex/gpt-6-sol` sits in the default `design` list; its unlabeled saved twin folded in,
  // so the surviving row falls back to the direct table's human label.
  expect(byId.has('codex-gpt-6-sol')).toBe(false)
  expect(byId.get('codex/gpt-6-sol')).toMatchObject({ label: 'Codex GPT-6 Sol', usedIn: [{ class: 'design', position: 2 }] })
  expect(byId.get('devin')).toMatchObject({ label: 'Devin SWE-2', provider: 'Devin', billing: 'промо', main: true })
  // The saved profile `codex` is gpt-6-astra: folded into the direct row, which keeps the saved
  // label and inherits the `codex` entry's slot in the default `review` class.
  expect(byId.has('codex')).toBe(false)
  expect(byId.get('codex/gpt-6-astra')).toMatchObject({ label: 'Codex GPT-6 Astra', provider: 'Codex', main: true, usedIn: [{ class: 'review', position: 1 }] })
  // A saved profile the owner never wired in is kept but demoted out of the main list.
  expect(byId.get('gemini-cli')).toMatchObject({ label: 'Gemini', provider: 'Другие', main: false, usedIn: [] })
  // V-wo1/billing: billing and section follow the transport — a Gemini CLI profile is a subscription CLI, not «API»;
  // an older tool's profile nothing uses waits in «Other / imported», one the routing names sits under its CLI.
  expect(byId.get('gemini-cli')).toMatchObject({ billing: 'подписка', section: 'other', other: 'imported', transport: 'gemini-cli' })
  expect(byId.get('devin')).toMatchObject({ section: 'subscription', cli: 'devin', transport: 'devin-acp' })
  expect(byId.get('claude/opus')).toMatchObject({ section: 'subscription', cli: 'claude', name: 'Claude Opus 5' })
  expect(byId.get('dsh/deepseek-flash')).toMatchObject({ section: 'dsh', billing: 'API' })
  // V-wo1/adopt: «Add as worker» moves it to its CLI's section.
  expect((await call('POST', '/crewboard/api/worker-adopt', { repo: root, id: 'gemini-cli' })).json.value).toEqual({ adopted: 'gemini-cli' })
  const adopted = (await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value?.workers.find((w) => w.id === 'gemini-cli')
  // rb1: Crewboard now has a runner for Gemini CLI — adopted, it is a main worker like any other.
  expect(adopted).toMatchObject({ section: 'subscription', cli: 'gemini', main: true })
  expect(adopted).not.toHaveProperty('runs')
  expect(byId.get('claude/opus')).not.toHaveProperty('runs')
  // The screen learns which CLIs run from the host (core's cliRuns), never from a table of names.
  const listed = (await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value as { runnableClis?: string[] } | undefined
  expect(listed?.runnableClis).toEqual(expect.arrayContaining(['claude', 'codex', 'devin', 'opencode', 'cursor', 'gemini', 'grok']))
  expect(await call('POST', '/crewboard/api/worker-adopt', { repo: root, id: 'gemini-cli' })).toMatchObject({ status: 404 })
  // V-wo1/forget: a stale id leaves the routing.
  expect((await call('POST', '/crewboard/api/workers-save', { repo: root, routing: { ...DEFAULT_ROUTING, classes: { ...DEFAULT_ROUTING.classes, code: ['codex-reserve', ...DEFAULT_ROUTING.classes.code] } } })).status).toBe(200)
  const stale = (await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value?.workers.find((w) => w.id === 'codex-reserve')
  expect(stale).toMatchObject({ section: 'other', other: 'stale', main: false })
  expect((await call('POST', '/crewboard/api/worker-forget', { repo: root, id: 'codex-reserve' })).json.value).toEqual({ routing: true, presets: [] })
  expect((await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value?.routing.classes.code).toEqual(DEFAULT_ROUTING.classes.code)
  const next = { ...DEFAULT_ROUTING, classes: { ...DEFAULT_ROUTING.classes, design: [...DEFAULT_ROUTING.classes.design, 'codex-gpt-6-sol'] }, disabled: { 'claude/opus': 'нет лимитов', 'codex-gpt-6-sol': 'pause' } }
  expect((await call('POST', '/crewboard/api/workers-save', { repo: root, routing: next })).status).toBe(200)
  expect(JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8'))).toMatchObject({ profiles: { devin: {} }, routing: { disabled: { 'claude/opus': 'нет лимитов' } } })
  expect(JSON.parse(await readFile(config, 'utf8'))).not.toHaveProperty('routing')
  const deleted = await call('POST', '/crewboard/api/worker-delete', { repo: root, id: 'codex/gpt-6-sol' })
  expect(deleted.status).toBe(200)
  expect(deleted.json.value).toMatchObject({ removed: ['codex/gpt-6-sol', 'codex-gpt-6-sol'] })
  const afterDelete = (await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value?.routing
  expect(afterDelete?.classes.design).not.toContain('codex/gpt-6-sol')
  expect(afterDelete?.classes.design).not.toContain('codex-gpt-6-sol')
  expect(afterDelete?.disabled).not.toHaveProperty('codex-gpt-6-sol')
  expect(await call('POST', '/crewboard/api/workers-save', { repo: root, routing: { classes: { code: 'dsh' }, disabled: {} } })).toMatchObject({ status: 400, json: { error: 'bad_request' } })

  const preset = { id: 'dsh-only', label: 'Dsh only', routing: { code: ['dsh'], design: ['dsh'], review: ['dsh'], research: ['dsh'] } }
  expect((await call('POST', '/crewboard/api/presets', { repo: root, preset })).status).toBe(200)
  expect((await call('POST', '/crewboard/api/repo-preset', { repo: root, id: preset.id })).status).toBe(200)
  expect((await call('POST', '/crewboard/api/plan-preset', { repo: root, planId: 'main', id: preset.id })).status).toBe(200)
  expect(service.snapshot().repos[0]?.effectiveRouting).toMatchObject({ source: 'plan', preset: { id: preset.id } })
  expect(service.snapshot().repos[0]?.plans?.[0]?.effectiveRouting).toMatchObject({ source: 'plan' })
  expect((await call('GET', `/crewboard/api/presets?repo=${encodeURIComponent(root)}`)).json.value).toMatchObject({ effectiveRouting: { source: 'plan' } })
  expect((await call('POST', '/crewboard/api/preset-delete', { repo: root, id: preset.id })).json.value).toMatchObject({ usedIn: expect.arrayContaining([`${root}:repository`, `${root}:plan:main`]) })
})

it('V-ef1/label one model registered at two efforts lists as two workers named with their effort', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-wr-effort-'))
  const home = await mkdtemp(join(tmpdir(), 'orch-wr-effort-home-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {} }))
  await initPlan(root, 'g')
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => new Date(), env: { HOME: home } })
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home, now: () => new Date() })
  const call = async (method: string, url: string, body?: unknown) => {
    const route = routes.find((r) => r.path === url.split('?')[0])
    if (!route) throw new Error(`no route ${url}`)
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return JSON.parse(res.body) as { ok: boolean; value?: { workers: Array<{ id: string; label: string }> } }
  }
  const sonnet = { kind: 'claude', model: 'claude-sonnet-5', label: 'Claude Sonnet 5', billing: 'подписка' }
  for (const entry of [{ ...sonnet, id: 'claude/sonnet-5-high', effort: 'high' }, { ...sonnet, id: 'claude/sonnet-5-medium', effort: 'medium' }, { id: 'dsh/deepseek-flash', kind: 'dsh', model: 'deepseek-flash', label: 'DeepSeek V4 Flash (dsh)', effort: 'high', billing: 'API' }]) {
    expect((await call('POST', '/crewboard/api/worker-save', { repo: root, entry })).ok).toBe(true)
  }
  const expected = { 'claude/sonnet-5-high': 'Claude Sonnet 5 · high', 'claude/sonnet-5-medium': 'Claude Sonnet 5 · medium', 'dsh/deepseek-flash': 'DeepSeek V4 Flash (dsh)' }
  const listed = (await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).value?.workers ?? []
  expect(Object.fromEntries(listed.filter((w) => w.id in expected).map((w) => [w.id, w.label]))).toEqual(expected)
  // The snapshot's list names the panel's worker line the same way.
  const snapshot = await resolvedWorkers({}, home)
  expect(Object.fromEntries(snapshot.filter((w) => w.id in expected).map((w) => [w.id, w.label]))).toEqual(expected)
})

async function pv1Host(controller?: { modelCatalog(): Promise<unknown> }, exec?: import('@crewboard/core').Exec) {
  const root = await mkdtemp(join(tmpdir(), 'orch-wr-pv1-'))
  const home = await mkdtemp(join(tmpdir(), 'orch-wr-pv1-home-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {} }))
  await initPlan(root, 'g')
  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const native: Native = { confirm: async () => true, notify: async () => {} }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => new Date(), env: { HOME: home } })
  const sessions = controller ? () => controller as unknown as import('../src/host/dsh.js').SessionControllerFace : undefined
  const routes = actionRoutes({ service, repos: [root], backendsFor: () => backends, native, env: {}, home, now: () => new Date(), lang: () => 'en', ...(sessions ? { sessions } : {}), ...(exec ? { exec } : {}) })
  const call = async (method: string, url: string, body?: unknown) => {
    const route = routes.find((r) => r.path === url.split('?')[0])
    if (!route) throw new Error(`no route ${url}`)
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
    Object.assign(req, { method, url, headers: { 'content-type': 'application/json', [CLIENT_HEADER]: '1' } })
    const res = { status: 0, body: '', writeHead(s: number) { res.status = s; return res }, end(c?: string) { if (c) res.body += c } }
    await route.handler(req, res as unknown as ServerResponse)
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; error?: string; value?: Record<string, unknown> } }
  }
  const workers = async () => ((await call('GET', `/crewboard/api/workers?repo=${encodeURIComponent(root)}`)).json.value?.workers ?? []) as Array<{ id: string; label: string; provider: string; main: boolean; dsh?: { provider: string; providerName: string; model: string; missing?: true } }>
  return { root, home, call, workers }
}

const CATALOG = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash' },
  routableProviders: ['deepseek-official', 'openrouter', 'broken'],
  groups: [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek V4 Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
    { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'qwen/qwen-4', name: 'Qwen 4' }] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'no key' }],
}

it('V-pv1/catalog lists every dsh model as a worker, the old id standing for its DeepSeek model', async () => {
  const { workers } = await pv1Host({ modelCatalog: async () => CATALOG })
  const dsh = (await workers()).filter((w) => w.dsh)
  expect(dsh.map((w) => [w.id, w.label, w.dsh?.providerName])).toEqual([
    // The registry's `dsh/deepseek-flash` is the catalog's deepseek-official/deepseek-flash: one row, under the old id.
    ['dsh/deepseek-flash', 'DeepSeek V4 Flash · via dsh', 'DeepSeek'],
    ['dsh/deepseek-official/deepseek-v4-pro', 'DeepSeek V4 Pro · via dsh', 'DeepSeek'],
    ['dsh/openrouter/qwen/qwen-4', 'Qwen 4 · via dsh', 'OpenRouter'],
  ])
  expect(dsh.find((w) => w.id === 'dsh/openrouter/qwen/qwen-4')).toMatchObject({ provider: 'Другие', main: true, dsh: { provider: 'openrouter', model: 'qwen/qwen-4' } })
  expect(dsh.some((w) => w.dsh?.missing)).toBe(false)
})

it('V-wo1/builtin marks crewboard\'s own dsh route so an empty dsh shows it as waiting, not blocked', async () => {
  const { workers } = await pv1Host({ modelCatalog: async () => ({ ...CATALOG, groups: [], failures: [] }) })
  expect((await workers()).find((w) => w.id === 'dsh/deepseek-flash')?.dsh).toMatchObject({ missing: true, builtin: 'DeepSeek V4 Flash' })
})

it('V-pv1/missing keeps a model dsh dropped in its preset and marks it, but says nothing for a provider that failed to list', async () => {
  const { root, call, workers } = await pv1Host({ modelCatalog: async () => CATALOG })
  const preset = { id: 'api', label: 'API', routing: { code: ['dsh/openrouter/gone', 'dsh/broken/some-model'], design: [], review: [], research: [] } }
  expect((await call('POST', '/crewboard/api/presets', { repo: root, preset })).status).toBe(200)
  const listed = await workers()
  expect(listed.find((w) => w.id === 'dsh/openrouter/gone')).toMatchObject({ main: true, label: 'gone · via dsh', dsh: { provider: 'openrouter', providerName: 'OpenRouter', missing: true } })
  expect(listed.find((w) => w.id === 'dsh/broken/some-model')?.dsh).toEqual({ provider: 'broken', providerName: 'Broken', model: 'some-model' })
  // Without a catalog (an older dsh) nothing is claimed missing, and the registry keeps its own name.
  const bare = await pv1Host()
  expect((await bare.workers()).find((w) => w.id === 'dsh/deepseek-flash')).toMatchObject({ label: 'DeepSeek V4 Flash (dsh)' })
  expect((await bare.workers()).every((w) => !w.dsh?.missing)).toBe(true)
})

it('V-pv1/add-models lists a CLI\'s models and registers the chosen models and efforts', async () => {
  const exec: import('@crewboard/core').Exec = async (cmd, args) => ({ code: 0, stdout: cmd === 'codex' && args.join(' ') === 'debug models --bundled' ? JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'high' }] }] }) : '', stderr: '', timedOut: false })
  const { root, call, workers } = await pv1Host(undefined, exec)
  expect((await call('POST', '/crewboard/api/worker-models', { repo: root, kind: 'codex' })).json.value).toMatchObject({ kind: 'codex', source: 'cli', models: [{ model: 'gpt-6-astra', efforts: ['high'] }] })
  expect((await call('POST', '/crewboard/api/worker-models', { repo: root, kind: 'dsh' })).status).toBe(400)
  const added = await call('POST', '/crewboard/api/worker-add-models', { repo: root, kind: 'claude', models: [{ model: 'claude-sonnet-5', label: 'Claude Sonnet 5' }], efforts: ['high', 'medium'] })
  expect(added.json.value).toEqual({ added: ['claude/sonnet-5-high', 'claude/sonnet-5-medium'], existing: [] })
  expect((await workers()).find((w) => w.id === 'claude/sonnet-5-high')).toMatchObject({ label: 'Claude Sonnet 5 · high', provider: 'Claude' })
  expect(await call('POST', '/crewboard/api/worker-add-models', { repo: root, kind: 'claude', models: [{ model: 'claude-sonnet-5' }], efforts: ['minimal'] })).toMatchObject({ status: 400, json: { error: 'bad_request' } })
  expect(await call('POST', '/crewboard/api/worker-add-models', { repo: root, kind: 'codex', models: [] })).toMatchObject({ status: 400 })
})
