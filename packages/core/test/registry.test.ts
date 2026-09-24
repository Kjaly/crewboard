import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WORKERS, defaultMinCliVersion, deleteWorker, loadRegistry, registryPath, saveWorker } from '../src/routing/registry.js'
import { removeWorker } from '../src/routing/delete.js'
import { DEFAULT_ROUTING, loadRouting, saveRouting } from '../src/routing/routing.js'

describe('worker registry', () => {
  it('uses the complete legacy direct worker list when no registry file exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-registry-'))
    const got = await loadRegistry(join(dir, 'workers.json'))
    expect(got).toEqual({ version: 1, workers: DEFAULT_WORKERS })
    expect(DEFAULT_WORKERS.map((w) => w.id)).toEqual([
      'dsh/deepseek-flash', 'claude/opus', 'claude/fable', 'codex/gpt-6-astra', 'codex/gpt-6-sol',
      'codex/gpt-6-luna', 'codex/gpt-5.6-sol', 'codex/gpt-5.6-terra', 'codex/gpt-5.6-luna',
    ])
    // The floor belongs to Opus 5.5 whatever the registry calls it; Opus 5 has none.
    expect(defaultMinCliVersion('claude/opus-5-5', 'claude-opus-5-5')).toBe('2.1.280')
    expect(defaultMinCliVersion('claude-opus', 'opus-5-5')).toBe('2.1.280')
    expect(defaultMinCliVersion('claude/opus', 'opus')).toBeUndefined()
    expect(defaultMinCliVersion('claude/sonnet-5', 'claude-sonnet-5')).toBeUndefined()
    expect(registryPath({ CREWBOARD_WORKERS_FILE: '/custom/workers.json' }, '/home/test')).toBe('/custom/workers.json')
  })

  it('replaces a worker by id and removes it from routing when deleted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-registry-'))
    const file = join(dir, 'workers.json')
    const original = DEFAULT_WORKERS[0]!
    await saveWorker(file, { ...original, label: 'Новое имя' })
    expect((await loadRegistry(file)).workers.filter((w) => w.id === original.id)).toHaveLength(1)
    expect((await loadRegistry(file)).workers.find((w) => w.id === original.id)?.label).toBe('Новое имя')
    await deleteWorker(file, original.id)
    expect((await loadRegistry(file)).workers.some((w) => w.id === original.id)).toBe(false)
    await expect(deleteWorker(file, original.id)).rejects.toMatchObject({ code: 'unknown_worker' })
  })

  it('removes the exact id and saved aliases together and reports them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-delete-'))
    const registry = join(dir, 'workers.json')
    const config = join(dir, 'config.json')
    await loadRegistry(registry)
    await saveRouting(config, { classes: { ...DEFAULT_ROUTING.classes, review: ['codex', 'codex-gpt-6-astra', 'codex/gpt-6-astra'] }, disabled: { codex: 'pause' } })
    const result = await removeWorker(registry, config, 'codex/gpt-6-astra')
    expect(result.removed).toEqual(expect.arrayContaining(['codex/gpt-6-astra', 'codex', 'codex-gpt-6-astra']))
    expect((await loadRouting(config)).classes.review).toEqual([])
    expect((await loadRouting(config)).disabled).toEqual({})
    expect((await loadRegistry(registry)).workers.some((worker) => worker.id === 'codex/gpt-6-astra')).toBe(false)
  })

  it('recovers a journal left between the two writes before another deletion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orch-delete-recover-'))
    const registry = join(dir, 'workers.json')
    const config = join(dir, 'config.json')
    await loadRegistry(registry)
    await saveRouting(config, DEFAULT_ROUTING)
    const backup = { registry: await readFile(registry, 'utf8'), routing: await readFile(config, 'utf8') }
    await writeFile(`${registry}.delete-journal`, JSON.stringify(backup))
    await saveRouting(config, { ...DEFAULT_ROUTING, classes: { ...DEFAULT_ROUTING.classes, design: [] } })
    await removeWorker(registry, config, 'claude/opus')
    expect((await loadRouting(config)).classes.design).toEqual(DEFAULT_ROUTING.classes.design)
    expect((await loadRegistry(registry)).workers.some((worker) => worker.id === 'claude/opus')).toBe(false)
  })
})
