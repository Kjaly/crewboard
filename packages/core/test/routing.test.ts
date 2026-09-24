import { olderConfigPath } from '../src/routing/profile-store.js'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { launchTask } from '../src/orchestration/launch.js'
import { DEFAULT_ROUTING, candidates, classOfTask, loadRouting, saveRouting } from '../src/routing/routing.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'
import { savePreset, setRepositoryPreset } from '../src/routing/presets.js'

const NOW = new Date('2026-09-22T12:00:00Z')

describe('routing config', () => {
  it('migrates legacy routing once and saves only to the Orchestra store', async () => {
    const home = await mkdtemp(join(tmpdir(), 'orch-routing-'))
    const legacy = olderConfigPath({}, home)
    const file = join(home, 'profiles.json')
    const env = { HOME: home }
    await mkdir(join(legacy, '..'), { recursive: true })
    await writeFile(legacy, JSON.stringify({ agents: { devin: { backend: 'devin-cli', model: 'swe-2-high', enabled: false } }, routing: { classes: { design: ['devin'] }, disabled: { 'claude-opus': 'no quota' } } }))
    const r = await loadRouting(file, env, home)
    expect(r.classes.design).toEqual(['devin'])
    expect(r.classes.code).toEqual(DEFAULT_ROUTING.classes.code)
    expect(r.disabled).toEqual({ 'claude-opus': 'no quota' })
    await saveRouting(file, { ...r, disabled: { ...r.disabled, 'claude/opus': 'no quota' } }, env, home)
    const saved = JSON.parse(await readFile(file, 'utf8')) as { profiles: Record<string, unknown>; routing: { disabled: Record<string, string> } }
    expect(saved.profiles.devin).toBeDefined()
    expect(saved.routing.disabled).toEqual({ 'claude-opus': 'no quota', 'claude/opus': 'no quota' })
    expect(JSON.parse(await readFile(legacy, 'utf8'))).not.toHaveProperty('profiles')
    await expect(saveRouting(file, { ...r, classes: { ...r.classes, code: [1 as unknown as string] } }, env, home)).rejects.toBeInstanceOf(TypeError)
  })

  it('orders candidates and skips disabled workers; classes come from kind unless set', () => {
    const r = { classes: { ...DEFAULT_ROUTING.classes, design: ['claude/opus', 'devin', 'codex-gpt-5.6-sol'] }, disabled: { 'claude/opus': 'нет лимитов' } }
    expect(candidates(r, 'design')).toEqual(['devin', 'codex-gpt-5.6-sol'])
    expect(classOfTask({ kind: 'implement' })).toBe('code')
    expect(classOfTask({ kind: 'review' })).toBe('review')
    expect(classOfTask({ kind: 'research' })).toBe('research')
    expect(classOfTask({ kind: 'implement', class: 'design' })).toBe('design')
  })


})

describe('launchTask with routing', () => {
  async function setup(routing: object) {
    const root = await makeRepo()
    await writeFile(join(root, 'c.md'), 'do it\n')
    await initPlan(root, 'g', NOW)
    await updatePlan(root, (p) => {
      p.tasks.push(newTask({ id: 'ui', title: 'UI', contract: 'c.md', class: 'design' }), newTask({ id: 'fix', title: 'Fix', contract: 'c.md' }))
      return p
    })
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
    await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {}, routing }))
    const launched: string[] = []
    const backend: RunBackend = {
      id: 'dsh',
      launch: async ({ agent }) => {
        launched.push(agent)
        return `run_dsh-${launched.length}`
      },
      events: async () => [],
      status: async () => ({ status: 'running', terminal: false, exitCode: null }),
      steer: async () => {},
      cancel: async () => {},
    }
    const backends: Backends = { forAgent: async () => backend }
    const base = { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home, now: () => NOW }
    return { root, home, base, launched }
  }

  it('picks the first enabled worker of the task class when no agent is given', async () => {
    const { root, base, launched } = await setup({ classes: { design: ['claude/opus', 'dsh/deepseek-flash'], code: ['dsh'] }, disabled: { 'claude/opus': 'нет лимитов' } })
    expect(await launchTask({ ...base, taskId: 'ui' })).toMatchObject({ agent: 'dsh/deepseek-flash' })
    expect(await launchTask({ ...base, taskId: 'fix' })).toMatchObject({ agent: 'dsh' })
    expect(launched).toEqual(['dsh/deepseek-flash', 'dsh'])
    // The preset's pick is not an assignment (wp1): the attempt records it, the task keeps none.
    const ui = (await loadPlan(root)).tasks.find((t) => t.id === 'ui')
    expect(ui?.worker).toBeUndefined()
    expect(ui?.runs.at(-1)).toMatchObject({ agent: 'dsh/deepseek-flash', workerChoice: 'preset' })
  })

  it('refuses a disabled worker even when asked explicitly, and says when a class has no worker', async () => {
    const { base } = await setup({ classes: { design: ['claude/opus'] }, disabled: { 'claude/opus': 'нет лимитов' } })
    await expect(launchTask({ ...base, taskId: 'ui', agent: 'claude/opus', caller: 'person' })).rejects.toMatchObject({ code: 'disabled' })
    await expect(launchTask({ ...base, taskId: 'ui' })).rejects.toMatchObject({ code: 'no_worker' })
  })

  // A person's explicit enabled worker outside the preset runs, and the feed says it was a hand-picked
  // choice (owner, 2026-09-23). Since wp1 (2026-09-24) only a person may do this; see authority.test.ts.
  it('runs a person\'s explicit worker outside a preset, notes it, and uses the preset first by default', async () => {
    const { root, home, base } = await setup({ classes: { design: ['dsh/deepseek-flash', 'dsh'] } })
    const env = { HOME: home }
    await savePreset({ id: 'only-dsh', label: 'Only dsh', routing: { code: ['dsh'], design: ['dsh'], review: ['dsh'], research: ['dsh'] } }, env)
    await setRepositoryPreset(root, 'only-dsh', env)
    expect(await launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', caller: 'person' })).toMatchObject({ agent: 'dsh/deepseek-flash' })
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 'ui')
    expect(task?.notes.at(-1)?.text).toMatch(/Only dsh.*dsh\/deepseek-flash/)
  })

  it('still picks the preset first when no worker is named', async () => {
    const { root, home, base } = await setup({ classes: { design: ['dsh/deepseek-flash', 'dsh'] } })
    const env = { HOME: home }
    await savePreset({ id: 'only-dsh', label: 'Only dsh', routing: { code: ['dsh'], design: ['dsh'], review: ['dsh'], research: ['dsh'] } }, env)
    await setRepositoryPreset(root, 'only-dsh', env)
    expect(await launchTask({ ...base, taskId: 'ui' })).toMatchObject({ agent: 'dsh' })
  })

  it('runs the task worker without -a, keeps it, and records the actual worker of the attempt', async () => {
    const { root, base, launched } = await setup({ classes: { design: ['dsh'] } })
    await updatePlan(root, (p) => { Object.assign(p.tasks.find((t) => t.id === 'ui')!, { worker: 'dsh/deepseek-flash', workerSource: 'person' }); return p })
    expect(await launchTask({ ...base, taskId: 'ui' })).toMatchObject({ agent: 'dsh/deepseek-flash' })
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 'ui')
    expect(task?.worker).toBe('dsh/deepseek-flash')
    expect(task?.runs.at(-1)?.agent).toBe('dsh/deepseek-flash')
    expect(launched).toEqual(['dsh/deepseek-flash'])
  })

  it('refuses a prohibited task worker with its reason instead of falling back to the preset', async () => {
    const { root, base, launched } = await setup({ classes: { design: ['dsh'] }, disabled: { 'dsh/deepseek-flash': 'no quota' } })
    await updatePlan(root, (p) => { Object.assign(p.tasks.find((t) => t.id === 'ui')!, { worker: 'dsh/deepseek-flash', workerSource: 'person' }); return p })
    await expect(launchTask({ ...base, taskId: 'ui' })).rejects.toMatchObject({ code: 'disabled', message: expect.stringContaining('no quota') })
    expect(launched).toEqual([])
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'ui')?.worker).toBe('dsh/deepseek-flash')
  })

  it('re-assigns the task worker only when -a is passed', async () => {
    const { root, base } = await setup({ classes: { design: ['dsh'] } })
    await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'ui')!.worker = 'dsh'; return p })
    await launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', caller: 'person' })
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'ui')).toMatchObject({ worker: 'dsh/deepseek-flash', workerSource: 'person' })
  })

  it('refuses the task worker before launch when its CLI is older than the model requires', async () => {
    const { root, base } = await setup({ classes: { design: ['dsh'] } })
    await updatePlan(root, (p) => { Object.assign(p.tasks.find((t) => t.id === 'ui')!, { worker: 'claude/opus-5-5', workerSource: 'person' }); return p })
    const oldClaude = async (cmd: string, args: string[]) => {
      if (cmd === 'claude' && args[0] === '--version') return { code: 0, stdout: '2.1.216 (Claude Code)', stderr: '', timedOut: false }
      if (cmd === 'claude' && args[0] === 'auth') return { code: 0, stdout: '{"loggedIn":true}', stderr: '', timedOut: false }
      return nodeExec(cmd, args)
    }
    await expect(launchTask({ ...base, taskId: 'ui', skipPreflight: false, exec: oldClaude })).rejects.toMatchObject({
      code: 'preflight',
      detail: expect.stringContaining('2.1.216'),
    })
  })
})
