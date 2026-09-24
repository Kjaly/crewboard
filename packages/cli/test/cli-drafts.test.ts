import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type Backends, type RunBackend, loadDraft, loadPlan, nodeExec } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { cmdPlanDraft } from '../src/commands/drafts.js'
import { run } from '../src/cli.js'
import { makeHarness } from './harness.js'

it('parses a research worker final answer into a draft without approving it', async () => {
  const root = await makeRepo()
  const spec = join(root, 'spec.md')
  await writeFile(spec, '# Requirement\nBuild it')
  const answer = { id: 'spec-plan', goal: 'Build it', source: 'chat', lanes: ['core'], tasks: [{ id: 'build', title: 'Build', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Edit src/a.ts', acceptance: ['passes'], sources: ['Requirement'] }], decisions: [] }
  const backend: RunBackend = { id: 'dsh', launch: async ({ promptFile }) => { expect(await readFile(promptFile, 'utf8')).toContain('Build it'); return 'run_fake' }, status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }), events: async () => [{ ts: '', type: 'final', data: JSON.stringify(answer) }], steer: async () => {}, cancel: async () => {} }
  const backends: Backends = { forAgent: async (agent) => { expect(agent).toBe('dsh'); return backend } }
  const drafting = makeHarness({ cwd: root })
  expect(await cmdPlanDraft(['draft', '--from', spec, '-a', 'dsh'], drafting.io, nodeExec, () => backends)).toBe(0)
  expect(await loadDraft(root, 'spec-plan')).toMatchObject({ source: { name: 'spec.md', hash: expect.any(String) } })
  await expect(loadPlan(root, 'spec-plan')).rejects.toThrow()
  const bot = makeHarness({ cwd: root })
  expect(await run(['plan', 'approve', 'spec-plan'], bot.io)).toBe(1)
  const human = makeHarness({ cwd: root, isTTY: true, answers: ['y'] })
  expect(await run(['plan', 'approve', 'spec-plan'], human.io)).toBe(0)
  expect((await loadPlan(root, 'spec-plan')).tasks).toHaveLength(1)
})

it('follows a draft job with --wait, keeps a refused answer and repairs it from the CLI', async () => {
  const root = await makeRepo()
  await writeFile(join(root, 'bye.txt'), '# Bye')
  const good = { id: 'bye-plan', goal: 'Bye', source: 'chat', lanes: ['core'], tasks: [], decisions: ['Wave?'] }
  const answers = [JSON.stringify({ ...good, decisions: [['Wave?']] }), JSON.stringify(good)]
  const prompts: string[] = []
  let calls = 0
  const backend: RunBackend = {
    id: 'codex',
    launch: async ({ promptFile }) => { prompts.push(await readFile(promptFile, 'utf8')); return `run_fake-${prompts.length}` },
    // Each run reports "running" once, so --wait has to poll.
    status: async () => ({ status: calls++ % 2 ? 'completed' : 'running', terminal: calls % 2 === 0, exitCode: 0 }),
    events: async (runId) => [{ ts: '', type: 'final', data: answers[Number(runId.slice(-1)) - 1] }],
    steer: async () => {}, cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const first = makeHarness({ cwd: root })
  expect(await cmdPlanDraft(['draft', '--from', 'bye.txt', '-a', 'codex/gpt', '--wait'], first.io, nodeExec, () => backends)).toBe(1)
  expect(first.out()).toContain('needs repair')
  expect(first.out()).toContain('decisions[0]')
  const job = /Draft job (dj-[a-z0-9-]+) started/.exec(first.out())?.[1] ?? ''
  const fix = makeHarness({ cwd: root })
  expect(await cmdPlanDraft(['draft', 'repair', job, '--wait'], fix.io, nodeExec, () => backends)).toBe(0)
  expect(prompts[1]).toContain('Wave?')
  expect(await loadDraft(root, 'bye-plan')).toMatchObject({ decisions: ['Wave?'], source: { name: 'bye.txt' } })
})
