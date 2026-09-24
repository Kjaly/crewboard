import { mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { initPlan, newTask, updatePlan } from '@crewboard/core'
import { apply as clientApply } from '../src/client/index.js'
import { getLang, } from '../src/client/i18n.js'
import { resetLayout, selectMainPanel } from '../src/client/layout.js'
import { apply as hostApply } from '../src/host/index.js'
import type { HostContext, Route } from '../src/host/dsh.js'
import { strictCordis } from './helpers/strict-cordis.js'

const locale = (active: string) => ({ getSnapshot: () => ({ active }), subscribe: () => () => {}, addLanguage: () => () => {} })
afterEach(() => resetLayout())

it('client apply survives hostile roots, delayed grants, replacement and disposal', () => {
  const slots = { inject: (_slot: string, fn: () => unknown) => { fn() }, register: () => () => {} }
  const fake = strictCordis({ slots })
  expect(() => clientApply(fake.root)).not.toThrow()
  expect(selectMainPanel('crewboard')).toBe(false)
  expect(getLang()).toBe('en')
  const select = vi.fn()
  const unsubscribe = vi.fn()
  fake.grant('layout', { selectPanel: select })
  fake.grant('locale', { ...locale('ru'), subscribe: () => unsubscribe })
  expect(selectMainPanel('crewboard')).toBe(true)
  expect(getLang()).toBe('ru')
  fake.grant('locale', locale('en'))
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(getLang()).toBe('en')
  fake.revoke('layout')
  expect(selectMainPanel('crewboard')).toBe(false)
  fake.grant('layout', { selectPanel: select })
  expect(selectMainPanel('crewboard')).toBe(true)
  fake.dispose()
  expect(selectMainPanel('crewboard')).toBe(false)
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(select).toHaveBeenCalledTimes(2)
  const reapplied = strictCordis({ slots })
  clientApply(reapplied.root)
  reapplied.grant('locale', locale('ru'))
  expect(getLang()).toBe('ru')
  reapplied.dispose()
})

it('distinguishes an absent optional service from a malformed granted face', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const slots = { inject: (_slot: string, fn: () => unknown) => { fn() }, register: () => () => {} }
    const fake = strictCordis({ slots })
    clientApply(fake.root)
    expect(warning).not.toHaveBeenCalled()
    fake.grant('layout', { selectPanel: true })
    expect(warning).toHaveBeenCalledWith('[crewboard] dsh service boundary', expect.objectContaining({ service: 'layout', kind: 'shape' }))
    fake.dispose()
  } finally { warning.mockRestore() }
})

it('host apply uses injected Russian preference for the native confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orch-host-boundary-'))
  const priorHome = process.env.HOME
  process.env.HOME = root
  let service: { idle(): Promise<void> } | undefined
  try {
    await initPlan(root, 'goal')
    await updatePlan(root, (plan) => { plan.tasks.push(newTask({ id: 'decision', title: 'Decision', kind: 'decision' })); return plan })
    const routes: Route[] = []
    const fake = strictCordis({
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    })
    const confirm = vi.fn(async () => false)
    expect(() => hostApply(fake.root as unknown as HostContext, { repos: [root], refreshMs: 60_000, notifications: false }, { native: { confirm, notify: async () => {} }, onService: (s) => { service = s } })).not.toThrow()
    fake.grant('settings', { get: (namespace: string) => namespace === 'locale' ? { preference: 'ru' } : undefined })
    fake.grant('webServer', { register: (route: Route) => { routes.push(route); return () => {} } })
    const route = routes.find((item) => item.path === '/crewboard/api/accept')
    expect(route).toBeDefined()
    const ask = async () => {
      const req = Readable.from([Buffer.from(JSON.stringify({ repo: root, task: 'decision' }))]) as unknown as IncomingMessage
      Object.assign(req, { method: 'POST', url: route!.path, headers: { 'content-type': 'application/json', 'x-orchestra-client': '1' } })
      const res = { writeHead: () => res, end: () => {} } as unknown as ServerResponse
      await route!.handler(req, res)
    }
    await ask()
    expect(confirm).toHaveBeenCalledWith('crewboard', expect.stringContaining('Закрыть решение'), 'Принять', 'Отмена')
    fake.revoke('settings')
    await ask()
    expect(confirm).toHaveBeenLastCalledWith('crewboard', expect.stringContaining('Close decision'), 'Accept', 'Cancel')
    fake.dispose()
  } finally {
    if (priorHome === undefined) delete process.env.HOME
    else process.env.HOME = priorHome
    // The host's refresh writes under this HOME; wait for it before removing the directory.
    await service?.idle()
    await rm(root, { recursive: true, force: true })
  }
})
