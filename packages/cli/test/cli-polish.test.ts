import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Exec, nodeExec } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { programOf } from '../src/i18n.js'
import { makeHarness } from './harness.js'

const OPUS_FLOOR = '2.1.280'

/** `claude` answers with the given version (or is missing) and is logged in; everything else is real. */
const fakeClaude = (version?: string): Exec => async (cmd, args, opts) => {
  if (cmd !== 'claude') return nodeExec(cmd, args, opts)
  if (args[0] === '--version') return version ? { code: 0, stdout: `${version} (Claude Code)\n`, stderr: '', timedOut: false } : { code: 127, stdout: '', stderr: '', timedOut: false }
  return { code: 0, stdout: JSON.stringify({ loggedIn: true }), stderr: '', timedOut: false }
}

async function homeWith(profiles: Record<string, unknown>, workers: string[] = []): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orch-polish-home-'))
  await mkdir(join(home, '.config/crewboard'), { recursive: true })
  const order = ['devin', ...workers]
  await writeFile(join(home, '.config/crewboard/profiles.json'), JSON.stringify({ version: 1, routing: { classes: { code: order, design: order, review: order, research: order }, disabled: {} }, aliases: {}, profiles }))
  return home
}

describe('the program name', () => {
  it('help and usage lines repeat the invoked name, with the columns kept aligned', async () => {
    const column = (text: string) => {
      const lines = text.split('\n')
      const accept = lines.find((l) => l.includes('human only (interactive terminal)')) ?? ''
      const continuation = lines.find((l) => l.includes('orchestrator: run in background')) ?? ''
      return [accept.indexOf('human only'), continuation.search(/\S/)]
    }
    const short = makeHarness({ cwd: '/tmp', env: {} })
    short.io.program = 'orch'
    expect(await run(['--lang', 'en', '--help'], short.io)).toBe(0)
    expect(short.out()).toContain('Crewboard — plans and worker runs')
    expect(short.out()).toContain('\n  orch run <id>')
    expect(short.out()).not.toMatch(/\bcrewboard /)
    const [a, b] = column(short.out())
    expect(a).toBe(b)

    const long = makeHarness({ cwd: '/tmp', env: {} })
    long.io.program = 'crewboard'
    expect(await run(['--lang', 'en', '--help'], long.io)).toBe(0)
    expect(long.out()).toContain('\n  crewboard run <id>')
    expect(long.out()).not.toMatch(/\borch /)
    const [c, d] = column(long.out())
    expect(c).toBe(d)
    expect(c).toBe(a + 'crewboard'.length - 'orch'.length)

    const russian = makeHarness({ cwd: '/tmp', env: {} })
    russian.io.program = 'orch'
    expect(await run(['--lang', 'ru', '--help'], russian.io)).toBe(0)
    expect(russian.out()).toContain('Crewboard — планы и запуски воркеров')
    expect(russian.out()).toContain('Использование: orch plan draft')
    expect(russian.out()).not.toMatch(/\bcrewboard /)

    const usage = makeHarness({ cwd: '/tmp', env: {} })
    usage.io.program = 'orch'
    expect(await run(['--lang', 'en', 'accept'], usage.io)).toBe(2)
    expect(usage.err()).toMatch(/orch accept/)
  })

  it('names the alias only when started through it', () => {
    expect(programOf('/usr/local/bin/orch')).toBe('orch')
    expect(programOf('C:\\npm\\orch.cmd')).toBe('orch')
    expect(programOf('/usr/local/bin/crewboard')).toBe('crewboard')
    expect(programOf('/usr/local/lib/node_modules/crewboard/dist/main.js')).toBe('crewboard')
    expect(programOf(undefined)).toBe('crewboard')
  })
})

describe('launch refusals in both languages', () => {
  let root: string
  let env: NodeJS.ProcessEnv

  beforeEach(async () => {
    root = await makeRepo()
    const home = await homeWith({ devin: { transport: 'devin-acp', model: 'swe-2-high', displayName: 'Devin', enabled: true } }, ['claude/opus'])
    env = { ...process.env, HOME: home }
    await writeFile(join(root, 'task.md'), '<task>t</task>\n')
    const h = makeHarness({ cwd: root, env })
    await run(['init'], h.io)
    await run(['task', 'add', 'plan', '--title', 'P', '--kind', 'decision'], h.io)
    await run(['task', 'add', 'waits', '--title', 'W', '--deps', 'plan', '--contract', 'task.md'], h.io)
    await run(['task', 'add', 'bare', '--title', 'B'], h.io)
    await run(['task', 'add', 'red', '--title', 'R', '--contract', 'task.md'], h.io)
    await run(['task', 'add', 'red2', '--title', 'R2', '--contract', 'task.md'], h.io)
  })

  const refusal = async (lang: 'en' | 'ru', argv: string[], exec?: Exec) => {
    const h = makeHarness({ cwd: root, env })
    const code = await run(['--lang', lang, ...argv], h.io, exec)
    return { code, err: h.err() }
  }

  it.each([
    ['decision', ['run', 'plan', '-a', 'devin', '--skip-preflight'], 'This is a human decision: close it with crewboard accept.', 'Это решение человека: закрывается через crewboard accept.'],
    ['waiting', ['run', 'waits', '-a', 'devin', '--skip-preflight'], 'The task is waiting for: plan.', 'Задача ждёт: plan.'],
    ['no contract', ['run', 'bare', '-a', 'devin', '--skip-preflight'], 'No contract: pass --contract or run crewboard task set <id> --contract <file>.', 'Нет контракта: укажи --contract или crewboard task set <id> --contract <файл>.'],
  ])('%s', async (_name, argv, en, ru) => {
    for (const [lang, text] of [['en', en], ['ru', ru]] as const) {
      const r = await refusal(lang, argv)
      expect(r.code).toBe(1)
      expect(r.err).toBe(`${text}\n`)
    }
  })

  it('a red baseline', async () => {
    await mkdir(join(root, '.orchestration'), { recursive: true })
    await writeFile(join(root, '.orchestration/recipes.json'), JSON.stringify({ baseline: 'exit 1' }))
    const en = await refusal('en', ['run', 'red', '-a', 'devin', '--skip-preflight'])
    const ru = await refusal('ru', ['run', 'red2', '-a', 'devin', '--skip-preflight'])
    expect([en.code, ru.code]).toEqual([1, 1])
    expect(en.err).toMatch(/^The baseline run is red — the task is not sent to a worker\.\n/)
    expect(ru.err).toMatch(/^Базовый прогон красный — задача не уходит воркеру\.\n/)
  })

  it('a failed preflight, with its check details', async () => {
    const en = await refusal('en', ['run', 'red', '-a', 'claude/opus'], fakeClaude())
    const ru = await refusal('ru', ['run', 'red', '-a', 'claude/opus'], fakeClaude())
    expect([en.code, ru.code]).toEqual([1, 1])
    expect(en.err).toContain('✗ binary: not found → install Claude Code\n')
    expect(en.err).toContain('Preflight for claude/opus failed — the launch is cancelled.\n')
    expect(ru.err).toContain('✗ binary: не найден → установить Claude Code\n')
    expect(ru.err).toContain('Preflight для claude/opus не пройден — запуск отменён.\n')
    expect(en.err).not.toMatch(/[А-Яа-яЁё]/)
  })
})

describe('known errors', () => {
  it('an unknown task id is one line and exit code 1, in both languages', async () => {
    const root = await makeRepo()
    const init = makeHarness({ cwd: root, env: {} })
    await run(['init'], init.io)
    for (const [lang, text] of [['en', 'No task nope.'], ['ru', 'Нет задачи nope.']] as const) {
      const h = makeHarness({ cwd: root, env: {}, isTTY: true, answers: ['y'] })
      expect(await run(['--lang', lang, 'accept', 'nope'], h.io)).toBe(1)
      expect(h.err()).toBe(`${text}\n`)
      expect(h.err()).not.toMatch(/\n\s+at /)
    }
  })
})

describe('preflight without -a', () => {
  it('applies the per-model CLI floor like -a does', async () => {
    const home = await homeWith({ 'opus-worker': { transport: 'claude-cli', model: 'opus-5-5', displayName: 'Opus', enabled: true } })
    const env = { ...process.env, HOME: home }
    const all = makeHarness({ cwd: '/tmp', env })
    expect(await run(['--lang', 'en', 'preflight'], all.io, fakeClaude('2.0.0'))).toBe(1)
    expect(all.out()).toContain(`✗ version: Claude Code 2.0.0 is older than ${OPUS_FLOOR} required by opus-5-5 → update the CLI (claude update)`)
    const one = makeHarness({ cwd: '/tmp', env })
    expect(await run(['--lang', 'en', 'preflight', '-a', 'opus-worker'], one.io, fakeClaude('2.0.0'))).toBe(1)
    expect(one.out()).toBe(all.out())

    const ru = makeHarness({ cwd: '/tmp', env })
    expect(await run(['--lang', 'ru', 'preflight'], ru.io, fakeClaude('9.9.9'))).toBe(0)
    expect(ru.out()).toContain(`✓ version: Claude Code 9.9.9 — не ниже ${OPUS_FLOOR}, нужной модели opus-5-5`)
  })
})
