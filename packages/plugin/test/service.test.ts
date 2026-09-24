import { olderConfigPath } from '@crewboard/core'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Backends, initPlan, newTask, planPath, updatePlan, registryPath, saveWorker, workerSettingsProblem } from '@crewboard/core'
import { resolvedWorkers } from '../src/host/actions.js'
import { OrchestraService, type Watcher } from '../src/host/service.js'
import type { OrchestraSnapshot } from '../src/shared/types.js'

const NOW = new Date('2026-09-22T12:00:00Z')
const idle: Backends = {
  forAgent: async () => {
    throw new Error('no backend in this test')
  },
  }

async function repo(goal: string) {
  const root = await mkdtemp(join(tmpdir(), 'orch-svc-'))
  await initPlan(root, goal, NOW)
  await updatePlan(root, (p) => ({ ...p, tasks: [newTask({ id: 't1', title: 'T1' })] }))
  return root
}

describe('OrchestraService', () => {
  it('resolves a registry rename into the next snapshot', async () => {
    const root = await repo('Renamed worker')
    const home = await mkdtemp(join(tmpdir(), 'orch-workers-'))
    await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
    await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: { codex: { backend: 'codex-cli', model: 'gpt-6-astra', label: 'Codex GPT-6 Astra' } } }))
    const workersFor = () => resolvedWorkers({}, home)
    const svc = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW, workersFor })
    await svc.refresh()
    expect(svc.snapshot().workers.find((worker) => worker.id === 'codex/gpt-6-astra')?.label).toBe('Codex GPT-6 Astra')
    await saveWorker(registryPath({}, home), { id: 'codex/gpt-6-astra', kind: 'codex', model: 'gpt-6-astra', label: 'My review agent', billing: 'подписка' })
    await svc.refresh()
    expect(svc.snapshot().workers.find((worker) => worker.id === 'codex/gpt-6-astra')?.label).toBe('My review agent')
  })
  it('refreshes all repos and notifies subscribers', async () => {
    const [a, b] = [await repo('A'), await repo('B')]
    const svc = new OrchestraService({ config: { repos: [a, b], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
    const seen: OrchestraSnapshot[] = []
    const off = svc.subscribe((s) => seen.push(s))
    await svc.refresh()
    expect(svc.snapshot().repos.map((r) => r.goal)).toEqual(['A', 'B'])
    expect(seen).toHaveLength(1)
    off()
    await svc.refresh(a)
    expect(seen).toHaveLength(1)
  })

  it('refreshes one repo when its .orchestration directory changes', async () => {
    const a = await repo('A')
    let fire: () => void = () => {}
    const watcher: Watcher = (dir, onChange) => {
      expect(dir).toBe(join(a, '.orchestration'))
      fire = onChange
      return () => {}
    }
    const svc = new OrchestraService({ config: { repos: [a], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW, watcher, debounceMs: 10 })
    const stop = svc.start()
    try {
      await svc.refresh(a)
      await updatePlan(a, (p) => ({ ...p, goal: 'A2' }))
      const changed = new Promise<void>((resolve) => {
        const off = svc.subscribe((snapshot) => {
          if (snapshot.repos[0]?.goal === 'A2') {
            off()
            resolve()
          }
        })
      })
      fire()
      fire()
      await changed
      expect(svc.snapshot().repos[0]?.goal).toBe('A2')
    } finally {
      stop()
    }
  })

  it('keeps a missing plan as an expected repo snapshot', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'orch-svc-empty-'))
    const svc = new OrchestraService({ config: { repos: [empty], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
    await svc.refresh()
    expect(svc.snapshot().repos[0]).toMatchObject({ degraded: false, hasPlan: false, tasks: [] })
  })

  it('attaches the family and the pinned/hidden flags from the profile store', async () => {
    const root = await repo('Flags')
    const svc = new OrchestraService({
      config: { repos: [root], refreshMs: 60_000 },
      backendsFor: () => idle,
      now: () => NOW,
      prefsFor: async () => ({ [root]: { pinned: true, hidden: true } }),
    })
    await svc.refresh()
    expect(svc.snapshot().repos[0]).toMatchObject({ family: { root, name: basename(root) }, pinned: true, hidden: true })
  })

  // pq1: the host read a plan it could not parse on every tick and every watcher event, and each read
  // wrote a quarantine copy into the watched directory — which fired the watcher again.
  it('shows an unreadable plan as one degraded state without feeding the watcher', async () => {
    const root = await repo('Broken')
    const plan = JSON.parse(await readFile(planPath(root), 'utf8'))
    await writeFile(planPath(root), JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], title: 42 }] }))
    let fire: (file?: string) => void = () => {}
    const watcher: Watcher = (_dir, onChange) => { fire = onChange; return () => {} }
    const svc = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW, watcher, debounceMs: 5 })
    let refreshes = 0
    svc.subscribe(() => { refreshes++ })
    const stop = svc.start()
    try {
      await svc.idle()
      for (let i = 0; i < 5; i++) await svc.refresh()
      const copies = (await readdir(join(root, '.orchestration'))).filter((name) => name.includes('.corrupt-'))
      expect(copies).toHaveLength(1)
      const seen = refreshes
      fire(copies[0])
      await new Promise((resolve) => setTimeout(resolve, 40))
      await svc.idle()
      expect(refreshes).toBe(seen)
      expect(svc.snapshot().repos[0]).toMatchObject({ degraded: true, hasPlan: true, errorCode: 'plan_corrupt' })
    } finally {
      stop()
    }
  })

  it('names a plan from a newer build as incompatible and copies nothing', async () => {
    const root = await repo('Newer')
    const plan = JSON.parse(await readFile(planPath(root), 'utf8'))
    await writeFile(planPath(root), JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], status: 'parked' }] }))
    const svc = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW })
    for (let i = 0; i < 3; i++) await svc.refresh()
    expect(svc.snapshot().repos[0]).toMatchObject({ degraded: true, hasPlan: true, errorCode: 'plan_incompatible' })
    expect((await readdir(join(root, '.orchestration'))).filter((name) => name.includes('.corrupt-'))).toEqual([])
  })
})

describe('broken worker settings never hide the repositories (B07)', () => {
  it.each([
    ['routing without its classes', JSON.stringify({ version: 1, profiles: {}, aliases: {}, routing: { classes: {}, disabled: {} } }), 'incomplete'],
    ['a file that is not JSON', '{ "version": 1, routing', 'unreadable'],
  ])('%s: every repository is listed and the snapshot carries the problem', async (_name, content, code) => {
    const [a, b] = [await repo('A'), await repo('B')]
    const home = await mkdtemp(join(tmpdir(), 'orch-broken-workers-'))
    await mkdir(join(home, '.config', 'crewboard'), { recursive: true })
    await writeFile(join(home, '.config', 'crewboard', 'profiles.json'), content)
    const env = { HOME: home }
    const svc = new OrchestraService({ config: { repos: [a, b], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW, env, workersFor: () => resolvedWorkers(env, home), workerSettingsFor: () => workerSettingsProblem(env, home) })
    const seen: OrchestraSnapshot[] = []
    svc.subscribe((s) => seen.push(s))
    await svc.refresh()
    expect(svc.snapshot().repos.map((r) => r.goal)).toEqual(['A', 'B'])
    expect(seen.at(-1)?.repos).toHaveLength(2)
    expect(svc.snapshot().workerSettings).toMatchObject({ code })
    if (code === 'incomplete') {
      // Missing classes fall back to the defaults, so routing and the worker list still resolve.
      expect(svc.snapshot().workerSettings).toMatchObject({ classes: ['code', 'design', 'review', 'research'] })
      expect(svc.snapshot().repos[0]?.effectiveRouting?.routing.code.length).toBeGreaterThan(0)
      expect(svc.snapshot().workers.length).toBeGreaterThan(0)
    }
  })

  it('a sound settings file carries no problem', async () => {
    const a = await repo('A')
    const home = await mkdtemp(join(tmpdir(), 'orch-sound-workers-'))
    const env = { HOME: home }
    const svc = new OrchestraService({ config: { repos: [a], refreshMs: 60_000 }, backendsFor: () => idle, now: () => NOW, env, workersFor: () => resolvedWorkers(env, home), workerSettingsFor: () => workerSettingsProblem(env, home) })
    await svc.refresh()
    expect(svc.snapshot().workerSettings).toBeUndefined()
  })
})
