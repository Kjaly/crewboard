import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await makeRepo()
  env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
})

const task = async (id: string) => (await loadPlan(root)).tasks.find((t) => t.id === id)!
const statusRow = async (h: ReturnType<typeof makeHarness>, id: string) => {
  h.reset()
  await run(['status', '--json'], h.io)
  return JSON.parse(h.out()).views.find((v: { id: string }) => v.id === id)
}

describe('root tasks in the CLI (rt1)', () => {
  it('start → verify --done --report → review → accept, with run refused on the way', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init', '--goal', 'g'], h.io)
    expect(await run(['task', 'add', 'i1', '--title', 'Integrate on the stand', '--kind', 'root', '--contract', 'c.md'], h.io)).toBe(0)
    await writeFile(join(root, 'c.md'), 'stand\n')

    h.reset()
    expect(await run(['run', 'i1', '--skip-preflight'], h.io)).toBe(1)
    expect(h.err()).toContain("orchestrator's own work")
    expect(h.err()).toContain('start i1')
    expect((await task('i1')).runs).toEqual([])

    h.reset()
    expect(await run(['start', 'i1'], h.io), h.err()).toBe(0)
    expect(h.out()).toContain('verify i1 --done')
    expect(await statusRow(h, 'i1')).toMatchObject({ kind: 'root', status: 'running', byOrchestrator: true })
    h.reset()
    await run(['status'], h.io)
    expect(h.out()).toMatch(/i1 .*in work by the orchestrator/)

    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes/report.md'), 'Result: received\n\n- [x] pnpm test — passed\n\nEvidence: commit abc123\nReproduce: pnpm stand\n')
    h.reset()
    expect(await run(['verify', 'i1', '--done', '--note', 'stand integrated', '--report', 'notes/report.md'], h.io), h.err()).toBe(0)
    expect(h.out()).toContain('i1 done')
    expect(await task('i1')).toMatchObject({ status: 'in_review', check: { state: 'checked', note: 'stand integrated', report: '.orchestration/reports/main/i1.md' } })
    expect(await readFile(join(root, '.orchestration/reports/main/i1.md'), 'utf8')).toContain('Reproduce: pnpm stand')

    h.reset()
    await run(['attention'], h.io)
    expect(h.out()).toMatch(/i1: Integrate on the stand · .*checked/i)

    const human = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'] })
    expect(await run(['accept', 'i1'], human.io), human.err()).toBe(0)
    expect(await task('i1')).toMatchObject({ status: 'accepted' })
  })

  it('refuses start and --report where they do not apply, with exit codes an agent can read', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init', '--goal', 'g'], h.io)
    await run(['task', 'add', 'w', '--title', 'Worker task'], h.io)
    await run(['task', 'add', 'i1', '--title', 'I1', '--kind', 'root', '--deps', 'w'], h.io)
    h.reset()
    expect(await run(['start', 'w'], h.io)).toBe(1)
    expect(h.err()).toContain('not the orchestrator')
    h.reset()
    expect(await run(['start', 'i1'], h.io)).toBe(1)
    expect(h.err()).toContain('not ready')
    h.reset()
    expect(await run(['start'], h.io)).toBe(2)
    await writeFile(join(root, 'r.md'), 'Result: received\n')
    h.reset()
    expect(await run(['verify', 'w', '--done', '--note', 'x', '--report', 'r.md'], h.io)).toBe(1)
    h.reset()
    expect(await run(['verify', 'i1', '--done', '--note', 'x', '--report', 'missing.md'], h.io)).toBe(1)
    expect(h.err()).toContain('Cannot read the report file')
    expect(await run(['verify', 'i1', '--report', 'r.md'], h.io)).toBe(2)
    h.reset()
    expect(await run(['verify', 'i1'], h.io)).toBe(1)
    expect(h.err()).toContain('verify i1 --done')
  })

  it('a decision is prepared with verify --done and only then waits in Needs you (plan with a chat)', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init', '--goal', 'g'], h.io)
    await writeFile(join(root, '.orchestration/chats.json'), JSON.stringify({ main: { sessionId: 's1', wake: true, boundAt: '2026-09-22T11:00:00Z' } }))
    await run(['task', 'add', 'h4', '--title', 'Pick the stand', '--kind', 'decision'], h.io)
    expect(await statusRow(h, 'h4')).toMatchObject({ status: 'ready', preparing: true })
    h.reset()
    await run(['attention', '--json'], h.io)
    expect(JSON.parse(h.out())).toEqual([])
    h.reset()
    expect(await run(['verify', 'h4', '--done', '--note', 'A or B; recommend A'], h.io), h.err()).toBe(0)
    expect(h.out()).toContain('h4 prepared')
    h.reset()
    await run(['attention', '--json'], h.io)
    expect(JSON.parse(h.out())).toMatchObject([{ kind: 'decision', taskId: 'h4' }])
  })

  it('names a disputed reason in words, not as a code (w1b, B05)', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init', '--goal', 'g'], h.io)
    await run(['task', 'add', 'i2', '--title', 'Stand', '--kind', 'root'], h.io)
    await run(['start', 'i2'], h.io)
    expect(await run(['verify', 'i2', '--done', '--note', 'did it'], h.io), h.err()).toBe(0)
    const human = makeHarness({ cwd: root, env, isTTY: true, answers: ['n'] })
    const asked: string[] = []
    const prompt = human.io.prompt
    human.io.prompt = async (question: string) => { asked.push(question); return prompt(question) }
    await run(['accept', 'i2'], human.io)
    expect(asked[0]).toContain('Mismatch: the report makes no explicit result claim')
    expect(asked[0]).not.toContain('claim_missing')
  })

  it('task set --kind moves an open task to root and refuses a closed one', async () => {
    const h = makeHarness({ cwd: root, env })
    await run(['init', '--goal', 'g'], h.io)
    await run(['task', 'add', 'i1', '--title', 'I1', '--kind', 'decision'], h.io)
    expect(await run(['task', 'set', 'i1', '--kind', 'root'], h.io), h.err()).toBe(0)
    expect(await task('i1')).toMatchObject({ kind: 'root', status: 'ready' })
    h.reset()
    expect(await run(['task', 'set', 'i1', '--kind', 'chore'], h.io)).toBe(2)
    expect(h.err()).toContain('Unknown --kind: chore')

    await run(['task', 'add', 'd', '--title', 'D', '--kind', 'decision'], h.io)
    const human = makeHarness({ cwd: root, env, isTTY: true, answers: ['y'] })
    const asked: string[] = []
    const prompt = human.io.prompt
    human.io.prompt = async (question: string) => { asked.push(question); return prompt(question) }
    expect(await run(['accept', 'd'], human.io)).toBe(0)
    // No batch accept in the CLI; the one-task question names what the orchestrator has not prepared.
    expect(asked[0]).toContain('has not reported or prepared d')
    // A decision has no verdict (w1b, B05): the question names the choice, never a mismatch code.
    expect(asked[0]).toContain('Close decision d?')
    expect(asked[0]).not.toMatch(/claim_missing|Mismatch/)
    h.reset()
    expect(await run(['task', 'set', 'd', '--kind', 'root'], h.io)).toBe(1)
    expect(h.err()).toContain('the kind of a closed task does not change')
    expect(await task('d')).toMatchObject({ kind: 'decision', status: 'accepted' })
  })
})
