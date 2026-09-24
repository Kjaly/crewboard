import { olderConfigPath } from '@crewboard/core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { expect, it } from 'vitest'
import { type Backends, DEFAULT_ROUTING, initPlan } from '@crewboard/core'
import { CLIENT_HEADER, actionRoutes } from '../src/host/actions.js'
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
    return { status: res.status, json: JSON.parse(res.body) as { ok: boolean; value?: { routing: typeof DEFAULT_ROUTING; classes: Array<{ id: string; label: string }>; known: string[]; workers: Array<{ id: string; label: string; provider: string; billing: string; main: boolean; usedIn: Array<{ class: string; position: number }> }>; registry: Array<{ id: string }>; catalog: null | { groups: unknown[]; failures: unknown[] }; removed?: string[] }; error?: string } }
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
  expect(byId.get('claude/opus')).toMatchObject({ label: 'Claude Opus 5', provider: 'Claude', billing: 'подписка', main: true })
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
