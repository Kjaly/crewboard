import { olderConfigPath } from '@crewboard/core'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidates, loadPlan, loadRouting } from '@crewboard/core'
import { run } from '../src/cli.js'
import { makeRepo } from '../../core/test/git-helpers.js'
import { makeHarness } from './harness.js'

describe('orch workers', () => {
  it('removes a direct worker and every saved alias from routing', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    const config = join(home, '.config/crewboard/profiles.json')
    expect(await run(['workers', 'rm', 'codex/gpt-6-astra'], h.io)).toBe(0)
    const routing = await loadRouting(config, { HOME: home }, home)
    expect(routing.classes.review).not.toContain('codex')
    expect(candidates(routing, 'review')).not.toContain('codex')
    expect(Object.values(routing.classes).flat()).not.toContain('codex/gpt-6-astra')
    expect(h.out()).toContain('codex')
  })
  it('lists, disables, enables and reorders workers; tasks take a class', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
    const config = olderConfigPath({}, home)
    await writeFile(config, JSON.stringify({ agents: { devin: { backend: 'devin-cli', model: 'swe-2-high' } } }))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    expect(await run(['--lang', 'ru', 'workers'], h.io)).toBe(0)
    expect(h.out()).toContain('По готовому коду')
    expect(await run(['workers', 'disable', 'claude/opus', '--reason', 'нет лимитов'], h.io)).toBe(0)
    expect(await run(['workers', 'route', 'design', 'devin,codex-gpt-5.6-sol'], h.io)).toBe(0)
    expect(await run(['workers', 'route', 'nope', 'devin'], h.io)).toBe(2)
    const saved = JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8')) as { profiles: object; routing: { classes: { design: string[] }; disabled: Record<string, string> } }
    expect(saved.profiles).toHaveProperty('devin')
    expect(saved.routing.classes.design).toEqual(['devin', 'codex-gpt-5.6-sol'])
    expect(saved.routing.disabled).toEqual({ 'claude/opus': 'нет лимитов' })
    expect(await run(['workers', 'enable', 'claude/opus'], h.io)).toBe(0)
    expect((JSON.parse(await readFile(join(home, '.config/crewboard/profiles.json'), 'utf8')) as { routing: { disabled: object } }).routing.disabled).toEqual({})
    expect(await run(['workers', 'add', 'codex/custom', '--kind', 'codex', '--model', 'custom-model', '--label', 'Codex Custom'], h.io)).toBe(0)
    const registryFile = join(home, '.config/crewboard/workers.json')
    expect(JSON.parse(await readFile(registryFile, 'utf8'))).toMatchObject({ workers: expect.arrayContaining([expect.objectContaining({ id: 'codex/custom', model: 'custom-model' })]) })
    expect(await run(['workers', 'rm', 'codex/custom'], h.io)).toBe(0)
    await run(['init'], h.io)
    expect(await run(['task', 'add', 'ui', '--title', 'UI', '--class', 'design'], h.io)).toBe(0)
    expect((await loadPlan(root)).tasks[0]).toMatchObject({ class: 'design' })
    expect(await run(['task', 'add', 'x', '--title', 'X', '--class', 'bad'], h.io)).toBe(2)
  })
})
