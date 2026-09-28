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
  it('V-pv1/add-models lists a CLI\'s models and adds one worker per chosen model and effort', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    expect(await run(['workers', 'models', 'claude'], h.io)).toBe(0)
    expect(h.out()).toContain('claude-sonnet-5')
    expect(h.out()).toContain('[low, medium, high, xhigh, max]')
    expect(await run(['workers', 'add-models', 'claude', '--models', 'claude-sonnet-5', '--effort', 'high,low'], h.io)).toBe(0)
    expect(h.out()).toContain('added: claude/sonnet-5-high, claude/sonnet-5-low')
    const registry = JSON.parse(await readFile(join(home, '.config/crewboard/workers.json'), 'utf8')) as { workers: Array<{ id: string; model?: string; effort?: string }> }
    expect(registry.workers.find((w) => w.id === 'claude/sonnet-5-low')).toMatchObject({ model: 'claude-sonnet-5', effort: 'low' })
    // Again: nothing is overwritten.
    expect(await run(['workers', 'add-models', 'claude', '--models', 'claude-sonnet-5', '--effort', 'high'], h.io)).toBe(0)
    expect(h.out()).toContain('already registered, left as is: claude/sonnet-5-high')
    expect(await run(['workers', 'add-models', 'claude', '--models', 'claude-nope'], h.io)).toBe(2)
    expect(await run(['workers', 'add-models', 'claude', '--models', 'claude-sonnet-5', '--effort', 'minimal'], h.io)).toBe(2)
    expect(await run(['workers', 'add-models', 'dsh', '--models', 'x'], h.io)).toBe(2)
  })
  it('V-pv1/add-models reads Codex\'s own catalog through the configured binary', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const h = makeHarness({ cwd: root, env: { HOME: home, CREWBOARD_CODEX_COMMAND: '/opt/fake-codex' } })
    const seen: string[] = []
    const exec: import('@crewboard/core').Exec = async (cmd, args) => {
      seen.push([cmd, ...args].join(' '))
      return { code: 0, stdout: JSON.stringify({ models: [{ slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] }] }), stderr: '', timedOut: false }
    }
    expect(await run(['workers', 'add-models', 'codex', '--models', 'gpt-6-astra', '--effort', 'high'], h.io, exec)).toBe(0)
    expect(seen).toEqual(['/opt/fake-codex debug models --bundled'])
    expect(h.out()).toContain('added: codex/gpt-6-astra-high')
  })
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
  it('V-ef1/cli registers one model at two efforts and lists each with its effort', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    for (const effort of ['high', 'medium']) {
      expect(await run(['workers', 'add', `claude/sonnet-5-${effort}`, '--kind', 'claude', '--model', 'claude-sonnet-5', '--label', 'Claude Sonnet 5', '--effort', effort], h.io)).toBe(0)
    }
    expect(await run(['workers', '--all'], h.io)).toBe(0)
    // wo1: one line per model, each effort with its own worker id.
    expect(h.out()).toContain('    Claude Sonnet 5 · claude-sonnet-5 — high: claude/sonnet-5-high, medium: claude/sonnet-5-medium\n')
    expect(h.out()).toContain('    Claude Fable 5.1 · fable — claude/fable\n')
  })
  it('V-wo1/cli prints the three groups of the settings screen, each worker once', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const source = join(home, 'porch.json')
    // An older tool's profiles: a copy of claude/opus, a Gemini CLI profile, and a class naming an id nothing defines.
    await writeFile(source, JSON.stringify({ agents: { 'claude-big': { backend: 'claude-code', model: 'opus', label: 'Claude Big' }, gemini: { backend: 'gemini-cli', model: 'gemini-3.1-pro', label: 'Gemini' } } }))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    expect(await run(['workers', 'import-porch', source], h.io)).toBe(0)
    expect(await run(['workers', 'route', 'code', 'dsh/deepseek-flash,codex-reserve'], h.io)).toBe(0)
    h.reset()
    expect(await run(['workers', '--all'], h.io)).toBe(0)
    const out = h.out().slice(0, h.out().indexOf('From ready code'))
    const at = (text: string) => out.indexOf(text)
    expect(at('Subscriptions:')).toBeGreaterThanOrEqual(0)
    expect(at('Subscriptions:')).toBeLessThan(at('Via dsh (API)'))
    expect(at('Via dsh (API)')).toBeLessThan(at('Other / imported · 3:'))
    expect(out).toContain('  Claude — 2 models · 0 in presets\n    Claude Opus 5 · opus — claude/opus\n')
    expect(out).toContain('  Devin — 1 model · 1 in presets\n    devin\n')
    expect(out).toContain('  deepseek-official — 1 model · 1 in presets\n    DeepSeek V4 Flash (dsh) · deepseek-flash — dsh/deepseek-flash\n')
    expect(out).not.toContain('workers --all')
    expect(out).toContain('  claude-big — same CLI, model and effort as claude/opus')
    // Gemini CLI is a subscription CLI of its own, never «API»; imported and unused, it waits in «Other».
    expect(out).toContain('  gemini — Gemini · imported from an older tool\n')
    expect(out).toContain('  codex-reserve — nothing on this machine defines this id\n')
    for (const id of ['claude/opus', 'claude-big', 'gemini', 'codex-reserve', 'dsh/deepseek-flash']) expect(out.split(/[\s,;]/).filter((word) => word === id).length, id).toBe(id === 'claude/opus' ? 2 : 1)
  })
  it('V-wo2/cli folds each provider to one summary line; --all lists every model', async () => {
    const root = await makeRepo()
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    const source = join(home, 'porch.json')
    // An OpenCode profile a routing still names: listed under its CLI — rb1 runs it, so no reference note.
    await writeFile(source, JSON.stringify({ agents: { 'opencode-glm': { backend: 'opencode', model: 'zai/glm-5', label: 'GLM 5' }, 'opencode-kimi': { backend: 'opencode', model: 'moonshot/kimi-k3', label: 'Kimi K3' } } }))
    const h = makeHarness({ cwd: root, env: { HOME: home } })
    expect(await run(['workers', 'import-porch', source], h.io)).toBe(0)
    expect(await run(['workers', 'route', 'research', 'devin,opencode-glm,opencode-kimi'], h.io)).toBe(0)
    h.reset()
    expect(await run(['workers'], h.io)).toBe(0)
    const folded = h.out().slice(0, h.out().indexOf('From ready code'))
    expect(folded).toContain('  Claude — ')
    // rb1: Crewboard runs tasks on OpenCode — the folded line is a plain summary like any other provider's.
    expect(folded).toContain('  OpenCode — 2 models · 2 in presets\n')
    expect(folded).not.toContain('does not run tasks')
    expect(folded).toContain('Every model: crewboard workers --all\n')
    // Folded, no model row is printed under a provider.
    expect(folded).not.toMatch(/^ {4}\S/m)
    h.reset()
    expect(await run(['workers', '--all'], h.io)).toBe(0)
    expect(h.out()).toContain('  OpenCode — 2 models · 2 in presets\n    GLM 5 · zai/glm-5 — opencode-glm\n')
    h.reset()
    expect(await run(['--lang', 'ru', 'workers'], h.io)).toBe(0)
    expect(h.out()).toContain('  OpenCode — 2 модели · 2 в пресетах\n')
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
