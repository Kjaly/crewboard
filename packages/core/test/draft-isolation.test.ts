import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type Backends, type Exec, type LaunchInput, type RunBackend, LaunchError, advanceDraftJob, chooseDraftWorker, discardDraftJob, draftFailureHint,
  loadDraftJob, nodeExec, repairDraftJob, startDraftJob, summarizeDraftJob,
} from '../src/index.js'
import { createCliBackend } from '../src/runs/cli-backend.js'
import { type CliRunnerArgs, runCliRun } from '../src/runs/cli-runner.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-24T10:00:00Z')
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url))
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url))
/** The one verified channel for the real backend under test; the fake CLI makes no provider call. */
const CLAUDE_ENV = { ANTHROPIC_API_KEY: 'sk-ant-api03-test' }

const exists = (path: string) => stat(path).then(() => true, () => false)
const git = async (root: string, ...args: string[]) => (await nodeExec('git', ['-C', root, ...args])).stdout.trim()

/** A repository whose spec asks the worker to write a file; the worker below tries whatever its mode allows. */
async function repoWithSpec(spec = '# Bye\nSay bye. WRITE:evil.txt') {
  const root = await makeRepo()
  await writeFile(join(root, 'bye.md'), spec)
  await nodeExec('git', ['-C', root, 'add', '.'])
  await nodeExec('git', ['-C', root, 'commit', '-q', '-m', 'spec'])
  return root
}

/** The real Claude/Codex backend over the fake CLIs, supervised in this process so a launch returns when the run ends. */
function cliBackends(kind: 'claude' | 'codex', runsRoot: string, seen: CliRunnerArgs[] = []): Backends {
  const backend = createCliBackend({ kind, runsRoot, env: CLAUDE_ENV, command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], startRunner: (args, env) => { seen.push(args); return runCliRun(args, undefined, env) } })
  return { forAgent: async () => backend }
}

describe('draft isolation (dr2)', () => {
  it('launches Claude in plan permission mode and Codex in the read-only sandbox, never with write access', async () => {
    for (const kind of ['claude', 'codex'] as const) {
      const runDir = await mkdtemp(join(tmpdir(), `orch-ro-${kind}-`))
      const log = join(runDir, 'argv.log')
      process.env.FAKE_CLI_LOG = log
      await writeFile(join(runDir, 'prompt.md'), 'hello')
      const args: CliRunnerArgs = { kind, runDir, cwd: runDir, promptFile: join(runDir, 'prompt.md'), command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], readOnly: true }
      expect(await runCliRun(args, undefined, { ...process.env, ...CLAUDE_ENV })).toMatchObject({ status: 'completed' })
      const argv = JSON.parse((await readFile(log, 'utf8')).trim().split('\n')[0]!) as string[]
      if (kind === 'claude') {
        expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'plan']))
        expect(argv).not.toContain('--dangerously-skip-permissions')
      } else {
        expect(argv).toEqual(expect.arrayContaining(['-s', 'read-only']))
        expect(argv).not.toContain('workspace-write')
      }
    }
  })

  it('a Claude or Codex draft worker cannot create a file in the checkout, while the same worker outside a draft can', async () => {
    for (const kind of ['claude', 'codex'] as const) {
      const root = await repoWithSpec()
      const seen: CliRunnerArgs[] = []
      const backends = cliBackends(kind, join(root, '.orchestration', 'runs'), seen)
      const job = await startDraftJob({ root, spec: 'bye.md', agent: `${kind}/m`, backends, now: NOW })
      expect(seen[0]).toMatchObject({ cwd: root, readOnly: true })
      expect(job.attempts[0]).toMatchObject({ isolation: 'read_only' })
      expect(await exists(join(root, 'evil.txt'))).toBe(false)
      // The control: the same fake worker launched for a task (no read-only mode) does write, so the refusal above is the mode's.
      const plain = createCliBackend({ kind, runsRoot: join(root, '.orchestration', 'runs'), env: CLAUDE_ENV, command: process.execPath, commandArgs: [kind === 'claude' ? FAKE_CLAUDE : FAKE_CODEX], startRunner: (a, env) => runCliRun(a, undefined, env) })
      const prompt = join(root, '.orchestration', 'plain.md')
      await writeFile(prompt, 'WRITE:allowed.txt')
      await plain.launch({ agent: `${kind}/m`, promptFile: prompt, cwd: root })
      expect(await exists(join(root, 'allowed.txt'))).toBe(true)
    }
  })

  it('a backend without a read-only mode drafts in a throwaway worktree: the checkout stays untouched and the copy is removed', async () => {
    const root = await repoWithSpec()
    const readmeBefore = await readFile(join(root, 'README.txt'), 'utf8')
    const launches: LaunchInput[] = []
    let finished = false
    const backend: RunBackend = {
      id: 'dsh',
      // A worker that writes wherever it is started, like a dsh run with its usual tools.
      launch: async (input) => {
        launches.push(input)
        await writeFile(join(input.cwd, 'evil.txt'), 'x')
        await writeFile(join(input.cwd, 'README.txt'), 'changed\n')
        return 'run_dsh-1'
      },
      status: async () => (finished ? { status: 'completed', terminal: true, exitCode: 0 } : { status: 'running', terminal: false, exitCode: null }),
      events: async () => [{ ts: '', type: 'final', data: 'not json' }],
      steer: async () => {}, cancel: async () => {},
    }
    const backends: Backends = { forAgent: async () => backend }
    const job = await startDraftJob({ root, spec: 'bye.md', agent: 'dsh/deepseek-flash', backends, now: NOW })
    const copy = job.attempts[0]!.worktree!
    expect(job.attempts[0]).toMatchObject({ isolation: 'worktree' })
    expect(launches[0]).toMatchObject({ cwd: copy })
    expect(launches[0]!.readOnly).toBeUndefined()
    expect(copy.startsWith(root)).toBe(false)
    expect(await exists(join(root, 'evil.txt'))).toBe(false)
    expect(await readFile(join(root, 'README.txt'), 'utf8')).toBe(readmeBefore)
    expect(await git(root, 'status', '--porcelain', '--untracked-files=all', '--', '.', ':!.orchestration')).toBe('')
    expect(await git(root, 'worktree', 'list')).toContain(copy)
    finished = true
    expect(await advanceDraftJob(root, job.id, backends, NOW)).toMatchObject({ status: 'needs_repair' })
    expect(await exists(copy)).toBe(false)
    expect(await git(root, 'worktree', 'list')).not.toContain(copy)
  })

  it('removes the copy of a running attempt when the job is discarded, and refuses to draft without isolation outside git', async () => {
    const root = await repoWithSpec()
    const backend: RunBackend = { id: 'devin', launch: async () => 'run_devin-1', status: async () => ({ status: 'running', terminal: false, exitCode: null }), events: async () => [], steer: async () => {}, cancel: async () => {} }
    const backends: Backends = { forAgent: async () => backend }
    const job = await startDraftJob({ root, spec: 'bye.md', agent: 'devin', backends, now: NOW })
    await discardDraftJob(root, job.id, backends, NOW)
    expect(await exists(job.attempts[0]!.worktree!)).toBe(false)
    const plain = await mkdtemp(join(tmpdir(), 'orch-no-git-'))
    await writeFile(join(plain, 'bye.md'), '# Bye')
    await expect(startDraftJob({ root: plain, spec: 'bye.md', agent: 'devin', backends, now: NOW })).rejects.toMatchObject({ reason: 'no_isolation' })
    expect(await readdir(join(plain, '.orchestration', 'draft-runs')).catch(() => [])).toEqual([])
  })
})

/** Preflight over a fake machine: `devin` is missing, dsh is installed and has its key. */
const machine: Exec = async (cmd, args, opts) => {
  if (cmd === 'git') return nodeExec(cmd, args, opts)
  if (cmd === 'devin') return { code: 127, stdout: '', stderr: 'command not found: devin', timedOut: false }
  if (cmd === 'dsh') return { code: 0, stdout: 'dsh 1.4.0', stderr: '', timedOut: false }
  return { code: 127, stdout: '', stderr: `command not found: ${cmd}`, timedOut: false }
}

describe('draft worker choice (dr2)', () => {
  const context = async () => {
    const root = await repoWithSpec('# Bye')
    const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
    return { root, home, env: { HOME: home, DEEPSEEK_API_KEY: 'k' }, exec: machine, now: () => NOW, lang: 'en' as const }
  }

  it('walks the research preset like a run: skips a worker that fails preflight and says why', async () => {
    const o = await context()
    const choice = await chooseDraftWorker(o)
    expect(choice).toMatchObject({ agent: 'dsh/deepseek-flash', origin: 'auto', skipped: [{ id: 'devin', reason: expect.stringMatching(/binary|profile/) }] })
  })

  it('refuses a named worker that fails policy instead of replacing it', async () => {
    const o = await context()
    // Claude without an API key is refused by the API-only policy, not by a machine check.
    await expect(chooseDraftWorker({ ...o, agent: 'claude/opus' })).rejects.toMatchObject({ code: 'anthropic_api_key_missing' })
    await expect(chooseDraftWorker({ ...o, agent: 'claude/opus' })).rejects.toBeInstanceOf(LaunchError)
    expect(await chooseDraftWorker({ ...o, agent: 'dsh/deepseek-flash' })).toMatchObject({ agent: 'dsh/deepseek-flash', origin: 'explicit', skipped: [] })
  })

  it('names no worker when none passes, with every reason', async () => {
    const o = await context()
    await expect(chooseDraftWorker({ ...o, env: { HOME: o.home } })).rejects.toMatchObject({ code: 'no_worker', detail: expect.stringContaining('devin') })
  })
})

describe('failed draft attempt and retry (dr2)', () => {
  const failing = (runs: Map<string, { agent: string; failed: boolean }>, message: string): Backends => {
    const backend: RunBackend = {
      id: 'claude', readOnlyLaunch: true,
      launch: async ({ agent }) => { const id = `run_f-${runs.size + 1}`; runs.set(id, { agent, failed: true }); return id },
      status: async () => ({ status: 'failed', terminal: true, exitCode: 1 }),
      events: async () => [{ ts: '', type: 'run_failed', data: message }],
      steer: async () => {}, cancel: async () => {},
    }
    return { forAgent: async () => backend }
  }

  it('keeps the first line of the worker error with a hint, and a retry of an automatic pick picks again', async () => {
    const root = await repoWithSpec('# Bye')
    const runs = new Map<string, { agent: string; failed: boolean }>()
    const backends = failing(runs, 'Not logged in · Please run /login\n    at main (cli.js:1)')
    const job = await startDraftJob({ root, spec: 'bye.md', agent: 'claude/opus', pick: 'auto', backends, now: NOW })
    const failed = await advanceDraftJob(root, job.id, backends, NOW)
    expect(failed).toMatchObject({ status: 'failed', error: 'worker_failed', detail: 'Not logged in · Please run /login' })
    expect(summarizeDraftJob(failed)).toMatchObject({ status: 'failed', detail: 'Not logged in · Please run /login', hint: 'login', pick: 'auto' })
    let asked = 0
    const retried = await repairDraftJob({ root, id: job.id, backends, now: NOW, choose: async () => { asked++; return 'codex/gpt' } })
    expect(asked).toBe(1)
    expect(retried).toMatchObject({ status: 'running', pick: 'auto', attempts: [{ agent: 'claude/opus' }, { agent: 'codex/gpt', kind: 'draft' }] })
    expect(retried.detail).toBeUndefined()
    expect((await loadDraftJob(root, job.id)).attempts).toHaveLength(2)
  })

  it('a named worker stays with the job on retry', async () => {
    const root = await repoWithSpec('# Bye')
    const runs = new Map<string, { agent: string; failed: boolean }>()
    const backends = failing(runs, 'error: unknown option --permission-mode')
    const job = await startDraftJob({ root, spec: 'bye.md', agent: 'claude/opus', pick: 'explicit', backends, now: NOW })
    const failed = await advanceDraftJob(root, job.id, backends, NOW)
    expect(summarizeDraftJob(failed)).toMatchObject({ hint: 'update', pick: 'explicit' })
    const retried = await repairDraftJob({ root, id: job.id, backends, now: NOW, choose: async () => { throw new Error('must not pick') } })
    expect(retried.attempts.at(-1)).toMatchObject({ agent: 'claude/opus' })
  })

  it('reads the usual failures as a person’s next step', () => {
    expect(draftFailureHint('Invalid API key · Please run /login')).toBe('login')
    expect(draftFailureHint('Worker devin is disabled on this machine')).toBe('enable')
    expect(draftFailureHint('error: unexpected argument \'--sandbox\' found')).toBe('update')
    expect(draftFailureHint('socket hang up')).toBeUndefined()
  })
})
