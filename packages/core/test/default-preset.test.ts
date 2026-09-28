import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { type Exec, nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { LaunchError, launchTask } from '../src/orchestration/launch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, updatePlan } from '../src/plan/store.js'
import { assertWorkerChoice, presetAllows, presetName, presetWorkers } from '../src/routing/authority.js'
import { BUILTIN_PRESET_LABEL, resolveRouting, savePreset, setRepositoryPreset } from '../src/routing/presets.js'
import { olderConfigPath } from '../src/routing/profile-store.js'
import { makeRepo } from './git-helpers.js'

// nb1 (B32): the built-in preset runs the workers this machine actually has, says so in its name, never skips a
// worker silently, and a refusal names what could run the class.

const NOW = new Date('2026-09-25T12:00:00Z')

/** A fake machine: Claude Code is installed but has no API-key channel, dsh is installed with its key, nothing else exists. */
const machine: Exec = async (cmd, args, opts) => {
  if (cmd === 'git') return nodeExec(cmd, args, opts)
  if (cmd === 'claude' && args[0] === '--version') return { code: 0, stdout: '2.1.300 (Claude Code)', stderr: '', timedOut: false }
  if (cmd === 'claude' && args[0] === '--help') return { code: 0, stdout: 'Usage: claude [options]\n  --bare  Minimal mode', stderr: '', timedOut: false }
  if (cmd === 'claude') return { code: 0, stdout: JSON.stringify({ loggedIn: false }), stderr: '', timedOut: false }
  if (cmd === 'dsh') return { code: 0, stdout: 'dsh 1.4.0', stderr: '', timedOut: false }
  return { code: 127, stdout: '', stderr: `command not found: ${cmd}`, timedOut: false }
}

async function setup(classes: object) {
  const root = await makeRepo()
  await writeFile(join(root, 'c.md'), 'do it\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'fix', title: 'Fix', contract: 'c.md' }))
    return p
  })
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {}, routing: { classes } }))
  const launched: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async ({ agent }) => { launched.push(agent); return `run_dsh-${launched.length}` },
    events: async () => [],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const env = { HOME: home, DEEPSEEK_API_KEY: 'k' }
  const base = { root, backends, exec: machine, env, home, now: () => NOW, lang: 'en' as const }
  return { root, home, env, base, launched }
}

describe('the built-in preset uses the workers that pass preflight', () => {
  it('names itself for what it is and adds every other known worker after the class order', async () => {
    const { root, env } = await setup({ code: ['claude/opus'] })
    const routing = await resolveRouting(root, undefined, env)
    expect(routing.preset).toMatchObject({ builtin: true, label: BUILTIN_PRESET_LABEL })
    expect(presetName(routing, 'en')).toBe('Default: workers that pass checks')
    expect(presetName(routing, 'ru')).toBe('По умолчанию: воркеры, прошедшие проверку')
    const order = presetWorkers(routing, 'code')
    expect(order[0]).toBe('claude/opus')
    expect(order).toContain('dsh/deepseek-flash')
    expect(order.filter((id) => id === 'claude/opus')).toHaveLength(1)
    // An agent may pick any installed worker of the built-in preset (ux2:F19).
    expect(presetAllows(routing, 'code', 'codex/gpt-6-luna')).toBe(true)
    expect(() => assertWorkerChoice({ caller: 'agent', routing, taskClass: 'code', worker: 'claude/fable', lang: 'en' })).not.toThrow()
  })

  it('skips the worker with no API-key channel, runs the next one that passes, and says so in the result and the task note', async () => {
    const { root, base, launched } = await setup({ code: ['claude/opus'] })
    const result = await launchTask({ ...base, taskId: 'fix' })
    expect(result).toMatchObject({ agent: 'dsh/deepseek-flash', skipped: [{ id: 'claude/opus', short: 'API-only route: no ANTHROPIC_API_KEY' }] })
    expect(launched).toEqual(['dsh/deepseek-flash'])
    const task = (await loadPlan(root)).tasks.find((t) => t.id === 'fix')
    const note = task?.notes.find((n) => n.event?.kind === 'worker_skipped')
    expect(note?.event).toEqual({ kind: 'worker_skipped', skipped: 'claude/opus', reason: 'API-only route: no ANTHROPIC_API_KEY', worker: 'dsh/deepseek-flash' })
    expect(note?.text).toBe('claude/opus skipped: API-only route: no ANTHROPIC_API_KEY → dsh/deepseek-flash')
    // The preset's pick is still not an assignment.
    expect(task?.worker).toBeUndefined()
  })

  it('a saved preset stays exactly its list: the refusal names installed workers that could do it and the route command', async () => {
    const { root, home, base } = await setup({ code: ['claude/opus'] })
    await savePreset({ id: 'only-opus', label: 'Only Opus', routing: { code: ['claude/opus'], design: ['claude/opus'], review: ['claude/opus'], research: ['claude/opus'] } }, { HOME: home })
    await setRepositoryPreset(root, 'only-opus', { HOME: home })
    const routing = await resolveRouting(root, undefined, { HOME: home })
    expect(routing.fallback).toEqual([])
    const refusal = await launchTask({ ...base, taskId: 'fix' }).catch((err: unknown) => err)
    expect(refusal).toBeInstanceOf(LaunchError)
    expect(refusal).toMatchObject({ code: 'no_worker', vars: { class: 'Code' } })
    const message = (refusal as LaunchError).message
    expect(message).toContain('dsh/deepseek-flash (ready, not in the preset)')
    // The API-only refusal is shown with its next step, never the subscription-login command.
    expect(message).toContain('Claude Code — API-only route: no ANTHROPIC_API_KEY')
    expect(message).not.toContain('claude auth login')
    expect(message).toContain('crewboard workers route code dsh/deepseek-flash')
    expect(message).not.toMatch(/Orchestra/)
    // A worker whose CLI is not installed is not offered.
    expect(message).not.toContain('codex/')
  })

  it('rq1: the built-in preset\'s fallback skips a porch-import profile and one with no runnable backend', async () => {
    const { root, home, env } = await setup({ code: ['claude/opus'] })
    await mkdir(join(home, '.config', 'crewboard'), { recursive: true })
    const path = join(home, '.config', 'crewboard', 'profiles.json')
    await writeFile(path, JSON.stringify({
      version: 1,
      routing: { classes: { code: ['claude/opus'], design: [], review: [], research: [] }, disabled: {} },
      aliases: {},
      profiles: {
        'opencode-kimi-k3': { model: 'kimi-k3', transport: 'opencode', displayName: 'Kimi K3', enabled: true, origin: 'porch-import' },
        'codex-reserve': { model: 'gpt-6-sol', transport: 'codex-cli', displayName: 'Reserve', enabled: true },
      },
    }))
    const routing = await resolveRouting(root, undefined, env)
    expect(routing.fallback).not.toContain('opencode-kimi-k3')
    // Not tagged porch-import, but `codex-reserve` is not an id `forAgent` would route either way.
    expect(routing.fallback).not.toContain('codex-reserve')
    expect(routing.fallback).toContain('dsh/deepseek-flash')
  })

  it('says in the reader\'s language when nothing is installed', async () => {
    const { base } = await setup({ code: ['claude/opus'] })
    const bare: Exec = async (cmd, args, opts) => (cmd === 'git' ? nodeExec(cmd, args, opts) : { code: 127, stdout: '', stderr: 'not found', timedOut: false })
    const refusal = await launchTask({ ...base, exec: bare, lang: 'ru', taskId: 'fix' }).catch((err: unknown) => err)
    expect(refusal).toMatchObject({ code: 'no_worker' })
    // The built-in preset's default refusal is the grouped block alone (rq1); the per-model "none" fallback
    // is verbose-only, since it would just restate what "Не установлены: …" already says.
    expect((refusal as LaunchError).message).not.toContain('нет — установите Claude Code, Codex или dsh')
    // Claude is refused by the API-only policy (its own next step), Codex alone reads as not installed;
    // neither line may recommend a subscription login.
    expect((refusal as LaunchError).message).toContain('Не запущены по политике Crewboard «только API» для Claude: Claude Code — только API: нет ANTHROPIC_API_KEY')
    expect((refusal as LaunchError).message).toContain('Не установлены: Codex.')
    expect((refusal as LaunchError).message).not.toContain('claude auth login')
    expect((refusal as LaunchError).message).toContain('crewboard workers route code <worker>')

    const verbose = await launchTask({ ...base, exec: bare, lang: 'ru', taskId: 'fix', verbose: true }).catch((err: unknown) => err)
    expect((verbose as LaunchError).message).toContain('нет — установите Claude Code, Codex или dsh')
  })
})
