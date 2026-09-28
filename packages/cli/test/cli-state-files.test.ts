import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { loadPlan, planPath, previousPlanPath } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

/** A write the test makes fail as a full or forbidden disk would: Node's errno error, no path on it. */
const failing = vi.hoisted(() => ({ code: undefined as string | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  const writeFile = (async (...args: Parameters<typeof real.writeFile>) => {
    if (failing.code && String(args[0]).includes('.orchestration')) throw Object.assign(new Error(`${failing.code}: simulated, write`), { code: failing.code, syscall: 'write' })
    return real.writeFile(...args)
  }) as typeof real.writeFile
  return { ...real, writeFile, default: { ...real, writeFile } }
})

async function planned() {
  const root = await makeRepo()
  const bot = makeHarness({ cwd: root })
  expect(await run(['init', '--goal', 'g'], bot.io)).toBe(0)
  expect(await run(['task', 'add', 'a', '--title', 'A'], bot.io)).toBe(0)
  return root
}

async function failingWith(code: string, fn: () => Promise<unknown>) {
  failing.code = code
  try { return await fn() } finally { failing.code = undefined }
}

describe('disk and permission errors on state files (sf1)', () => {
  it.each([
    ['ENOSPC', 'en', 'No space left on the disk for {path}; free some space and try again.'],
    ['EACCES', 'en', 'No permission to write {path}; check the owner and permissions of the file and its folder.'],
    ['EROFS', 'en', '{path} is on a read-only disk; Crewboard cannot write there.'],
    ['ENOSPC', 'ru', 'На диске нет места для {path}; освободите место и повторите.'],
  ])('%s (%s) is one sentence with the plan path, exit 1, no stack', async (code, lang, sentence) => {
    const root = await planned()
    const h = makeHarness({ cwd: root, env: { ...process.env, CREWBOARD_LANG: lang, LANG: lang === 'ru' ? 'ru_RU.UTF-8' : 'en_US.UTF-8' } })
    const exit = await failingWith(code, () => run(['--lang', lang, 'task', 'add', 'b', '--title', 'B'], h.io))
    expect(exit).toBe(1)
    expect(h.err()).toBe(`${sentence.replace('{path}', planPath(root))}\n`)
    expect(h.err()).not.toMatch(/\n\s+at /)
    expect((await loadPlan(root)).tasks.map((t) => t.id)).toEqual(['a'])
  })
})

describe('plan restore (sf1)', () => {
  it('a broken plan points to the restore, which a person confirms and which brings the previous version back', async () => {
    const root = await planned()
    await writeFile(planPath(root), '{ broken')
    const status = makeHarness({ cwd: root })
    expect(await run(['status'], status.io)).toBe(1)
    expect(status.err()).toContain('plan.json is damaged and cannot be read')
    expect(status.err()).toContain('plan restore --plan main')

    const agent = makeHarness({ cwd: root })
    expect(await run(['plan', 'restore'], agent.io)).toBe(1)
    expect(agent.err()).toContain('if you are a person, run it in a terminal')

    const no = makeHarness({ cwd: root, isTTY: true, answers: ['n'] })
    expect(await run(['plan', 'restore'], no.io)).toBe(1)
    expect(await readFile(planPath(root), 'utf8')).toBe('{ broken')

    const person = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['plan', 'restore'], person.io)).toBe(0)
    expect(person.out()).toContain('Plan main restored')
    expect((await loadPlan(root)).tasks).toEqual([])
  })

  it('without a previous version says so in one line', async () => {
    const root = await makeRepo()
    const bot = makeHarness({ cwd: root })
    await run(['init'], bot.io)
    const person = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
    expect(await run(['plan', 'restore'], person.io)).toBe(1)
    expect(person.err()).toBe(`Plan main has no previous version to restore: ${previousPlanPath(root)} does not exist.\n`)
  })
})

describe('read commands and a failing derived write (sf1)', () => {
  it('status answers while nothing can be written', async () => {
    const root = await planned()
    const h = makeHarness({ cwd: root })
    expect(await failingWith('EROFS', () => run(['status'], h.io))).toBe(0)
    expect(h.out()).toContain('a')
  })
})

describe('task set --status (sf1)', () => {
  it('a mistyped status names the statuses that exist', async () => {
    const root = await planned()
    const h = makeHarness({ cwd: root })
    expect(await run(['task', 'set', 'a', '--status', 'redy'], h.io)).toBe(2)
    expect(h.err()).toContain('Unknown status «redy»')
    expect(h.err()).toContain('backlog, ready, in_review, accepted, rejected, superseded, dropped')
    const real = makeHarness({ cwd: root })
    expect(await run(['task', 'set', 'a', '--status', 'accepted'], real.io)).toBe(2)
    expect(real.err()).toContain('--status accepts only backlog or ready')
  })
})
