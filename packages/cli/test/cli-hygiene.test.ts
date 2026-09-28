import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearConflictCache, nodeExec, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

// cl2: `--help`/no-args now open with what a newcomer needs; the rest of this file covers the other
// items — --version, «did you mean», the readable draft, the status summary and the accept preview.

beforeEach(() => clearConflictCache())

describe('crewboard --version', () => {
  it('prints the package version and nothing else', async () => {
    const h = makeHarness({ cwd: '/tmp', env: {} })
    expect(await run(['--version'], h.io)).toBe(0)
    expect(h.out()).toMatch(/^\d+\.\d+\.\d+\n$/)
  })
})

describe('an unknown command suggests the nearest one', () => {
  it.each([
    ['en', 'statuz', 'did you mean status?'],
    ['ru', 'statuz', 'может, вы имели в виду status?'],
  ] as const)('%s', async (lang, typo, phrase) => {
    const h = makeHarness({ cwd: '/tmp', env: {} })
    expect(await run(['--lang', lang, typo], h.io)).toBe(2)
    expect(h.err()).toContain(phrase)
  })

  it('says only «unknown command» when nothing is close', async () => {
    const h = makeHarness({ cwd: '/tmp', env: {} })
    expect(await run(['--lang', 'en', 'zzzzzzzzzzzz'], h.io)).toBe(2)
    expect(h.err()).toContain('Unknown command: zzzzzzzzzzzz')
    expect(h.err()).not.toMatch(/did you mean/i)
  })
})

async function draftRepo() {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root, env: {} })
  await run(['init'], h.io)
  await mkdir(join(root, '.orchestration/drafts'), { recursive: true })
  const draft = {
    id: 'd1', goal: 'Add a greeting command', source: 'chat', lanes: ['core'],
    tasks: [
      { id: 'greet', title: 'Add the greet command', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Add `src/greet.ts`.', acceptance: ['pnpm test passes'], sources: ['## Greeting'] },
      { id: 'greet-docs', title: 'Document it', lane: 'core', class: 'design', kind: 'implement', deps: ['greet'], contract: 'Update README.', acceptance: ['README shows an example'], sources: ['## Greeting'] },
    ],
    decisions: ['Should the greeting be localised?'],
  }
  await writeFile(join(root, '.orchestration/drafts/d1.json'), JSON.stringify(draft))
  return root
}

describe('plan draft show prints a readable draft by default', () => {
  it.each([
    ['en', 'Goal: Add a greeting command (d1)', 'Tasks:', 'Open questions:', ' (needs: greet)'],
    ['ru', 'Цель: Add a greeting command (d1)', 'Задачи:', 'Открытые вопросы:', ' (нужны: greet)'],
  ] as const)('%s', async (lang, goalLine, tasksWord, questionsWord, depsPhrase) => {
    const root = await draftRepo()
    const h = makeHarness({ cwd: root, env: {} })
    expect(await run(['--lang', lang, 'plan', 'draft', 'show', 'd1'], h.io)).toBe(0)
    expect(h.out()).toContain(goalLine)
    expect(h.out()).toContain(tasksWord)
    expect(h.out()).toContain('greet — Add the greet command [code]')
    expect(h.out()).toContain(`greet-docs — Document it [design]${depsPhrase}`)
    expect(h.out()).toContain(questionsWord)
    expect(h.out()).toContain('Should the greeting be localised?')
    expect(h.out()).not.toContain('"tasks"')
  })

  it('--json keeps the raw draft, in either language', async () => {
    const root = await draftRepo()
    const h = makeHarness({ cwd: root, env: {} })
    expect(await run(['--lang', 'ru', 'plan', 'draft', 'show', 'd1', '--json'], h.io)).toBe(0)
    expect(JSON.parse(h.out())).toMatchObject({ id: 'd1', goal: 'Add a greeting command' })
  })
})

async function statusRepo() {
  const root = await makeRepo()
  const h = makeHarness({ cwd: root, env: {} })
  await run(['init'], h.io)
  await run(['task', 'add', 'open1', '--title', 'Open one'], h.io)
  await run(['task', 'add', 'open2', '--title', 'Open two', '--backlog'], h.io)
  await run(['task', 'add', 'closeme', '--title', 'No longer needed'], h.io)
  const human = makeHarness({ cwd: root, env: {}, isTTY: true, answers: ['y'] })
  expect(await run(['drop', 'closeme', '--reason', 'not needed'], human.io)).toBe(0)
  return root
}

describe('status summarizes by default and --all shows everything', () => {
  it.each([
    ['en', '2 of 3 open', 'status --all'],
    ['ru', 'Открыто 2 из 3', 'status --all'],
  ] as const)('%s: default hides the closed task behind a summary and a hint', async (lang, summary, hint) => {
    const root = await statusRepo()
    const h = makeHarness({ cwd: root, env: {} })
    expect(await run(['--lang', lang, 'status'], h.io)).toBe(0)
    expect(h.out()).toContain(summary)
    expect(h.out()).toContain(hint)
    expect(h.out()).not.toContain('closeme')
    expect(h.out()).toContain('open1')
    expect(h.out()).toContain('open2')
  })

  it('--all lists every task, including the closed one, with no summary line', async () => {
    const root = await statusRepo()
    const h = makeHarness({ cwd: root, env: {} })
    expect(await run(['status', '--all'], h.io)).toBe(0)
    expect(h.out()).toContain('closeme')
    expect(h.out()).not.toMatch(/\d+ of \d+ open/)
  })
})

// sm1: accepted work leaves the open list once it is merged, but an accepted task still waiting on a
// merge stays listed — it still needs one — and counted apart in the summary.
const git = (dir: string, ...args: string[]) => nodeExec('git', ['-C', dir, ...args])

async function acceptedAndClosedPlan() {
  const root = await makeRepo()
  const home = await mkdtemp(join(tmpdir(), 'orch-home-'))
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: home, CREWBOARD_WORKTREE_CONFIG: join(home, 'worktrees.json') }
  const h = makeHarness({ cwd: root, env })
  await run(['init'], h.io)
  await run(['task', 'add', 'am', '--title', 'Accepted, merged'], h.io)
  await run(['task', 'add', 'au', '--title', 'Accepted, not merged'], h.io)
  await run(['task', 'add', 'cl', '--title', 'Closed on a negative verdict'], h.io)
  await run(['task', 'add', 'sp', '--title', 'Superseded'], h.io)
  await run(['task', 'add', 'dr', '--title', 'Dropped'], h.io)
  await run(['task', 'add', 'bl', '--title', 'Backlog', '--backlog'], h.io)
  await run(['task', 'add', 'ru', '--title', 'Running', '--kind', 'root'], h.io)
  // A real, unmerged branch (mg1): the merge-detection sync would otherwise mark a worktree pointing
  // nowhere as merged, since a branch and copy both gone looks like a cleaned-up merge.
  const copy = join(root, '..', 'repo-orch-au')
  await git(root, 'worktree', 'add', '-q', '-b', 'orch/au', copy, 'HEAD')
  await writeFile(join(copy, 'au.ts'), 'export const au = 1\n')
  await git(copy, 'add', '-A')
  await git(copy, 'commit', '-q', '-m', 'au')
  await updatePlan(root, (plan) => {
    const of = (id: string) => plan.tasks.find((t) => t.id === id)!
    of('am').status = 'accepted'
    of('au').status = 'accepted'
    of('au').worktree = { path: copy, branch: 'orch/au' }
    of('cl').status = 'accepted'
    of('cl').notes.push({ at: '2026-09-25T00:00:00Z', type: 'accept', text: 'closed', verdict: { kind: 'negative' } })
    of('sp').status = 'superseded'
    of('dr').status = 'dropped'
    return plan
  })
  await run(['start', 'ru'], h.io)
  return { root, env }
}

describe('status hides accepted work only once it is merged (sm1)', () => {
  it.each([
    ['en', '3 of 7 open · 1 accepted, not merged'],
    ['ru', 'Открыто 3 из 7 · 1 принята, не слита'],
  ] as const)('%s: the summary counts what is listed', async (lang, summary) => {
    const { root, env } = await acceptedAndClosedPlan()
    const h = makeHarness({ cwd: root, env })
    expect(await run(['--lang', lang, 'status'], h.io)).toBe(0)
    expect(h.out()).toContain(summary)
    // Hidden: merged-accepted, closed, superseded, dropped.
    for (const id of ['am', 'cl', 'sp', 'dr']) expect(h.out()).not.toContain(` ${id} `)
    // Listed: accepted-but-unmerged, backlog, running.
    for (const id of ['au', 'bl', 'ru']) expect(h.out()).toContain(` ${id} `)
  })

  it('--all lists all seven, with none hidden', async () => {
    const { root, env } = await acceptedAndClosedPlan()
    const h = makeHarness({ cwd: root, env })
    expect(await run(['status', '--all'], h.io)).toBe(0)
    for (const id of ['am', 'au', 'cl', 'sp', 'dr', 'bl', 'ru']) expect(h.out()).toContain(` ${id} `)
    expect(h.out()).not.toMatch(/\d+ of \d+ open/)
  })
})

describe('accept prints a one-line preview before asking', () => {
  it.each(['en', 'ru'] as const)('%s: verdict, check state and merge state, before the question', async (lang) => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root, env: {} })
    await run(['init'], h.io)
    await run(['task', 'add', 'd', '--title', 'D', '--kind', 'decision'], h.io)
    await run(['verify', 'd', '--done', '--note', 'A or B; recommend A'], h.io)
    const human = makeHarness({ cwd: root, env: {}, isTTY: true, answers: ['n'] })
    expect(await run(['--lang', lang, 'accept', 'd'], human.io)).toBe(1)
    const [summaryLine, ...rest] = human.out().split('\n')
    expect(summaryLine).toMatch(/^d: /)
    expect(summaryLine).toContain(lang === 'en' ? 'human decision' : 'решение человека')
    expect(summaryLine).toContain(lang === 'en' ? 'no conflicts with its base' : 'конфликтов с базой')
    expect(rest.join('\n')).toContain(lang === 'en' ? 'Cancelled.' : 'Отменено.')
  })
})

describe('a person-only command run by an agent points at a terminal', () => {
  it.each([
    ['en', 'if you are a person, run it in a terminal'],
    ['ru', 'если вы человек'],
  ] as const)('%s', async (lang, phrase) => {
    const root = await makeRepo()
    const h = makeHarness({ cwd: root, env: {} })
    await run(['init'], h.io)
    await run(['task', 'add', 't', '--title', 'T'], h.io)
    const agent = makeHarness({ cwd: root, env: {} })
    expect(await run(['--lang', lang, 'accept', 't'], agent.io)).toBe(1)
    expect(agent.err()).toContain(phrase)
  })
})
