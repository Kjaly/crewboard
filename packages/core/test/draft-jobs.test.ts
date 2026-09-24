import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Backends, type RunBackend, PLAN_DRAFT_JSON_SCHEMA, PlanDraftSchema, advanceDraftJob, advanceDraftJobs, checkDraftAnswer,
  draftJobAnswer, draftPrompt, listDraftJobs, loadDraft, loadDraftJob, recoverDraftOrphans, repairDraftJob, saveDraft, startDraftJob,
} from '../src/index.js'

const NOW = new Date('2026-09-24T10:00:00Z')
const task = { id: 'build', title: 'Build', lane: 'core', class: 'code', kind: 'implement', deps: [], contract: 'Edit `src/a.ts`', acceptance: ['passes'], sources: ['## Build'] }
const answer = (patch: Record<string, unknown> = {}) => JSON.stringify({ id: 'bye-plan', goal: 'Say bye', source: 'chat', lanes: ['core'], tasks: [task], decisions: [], ...patch })

/** Runs live in a map that plays the part of `.orchestration/runs`: a new Backends over the same map is a restarted host. */
type FakeRun = { terminal: boolean; status: string; answer?: string; prompt: string }
function fakeBackends(runs: Map<string, FakeRun>): Backends {
  const backend: RunBackend = {
    id: 'codex',
    launch: async ({ promptFile }) => { const id = `run_fake-${runs.size + 1}`; runs.set(id, { terminal: false, status: 'running', prompt: await readFile(promptFile, 'utf8') }); return id },
    status: async (id) => { const run = runs.get(id)!; return { status: run.status, terminal: run.terminal, exitCode: run.terminal ? 0 : null } },
    events: async (id) => { const run = runs.get(id)!; return run.answer === undefined ? [] : [{ ts: '', type: 'final', data: run.answer }] },
    steer: async () => {},
    cancel: async (id) => { Object.assign(runs.get(id)!, { terminal: true, status: 'cancelled' }) },
  }
  return { forAgent: async () => backend }
}
const finish = (runs: Map<string, FakeRun>, id: string, text: string) => Object.assign(runs.get(id)!, { terminal: true, status: 'completed', answer: text })

async function repoWithSpec() {
  const root = await mkdtemp(join(tmpdir(), 'orch-draft-jobs-'))
  await writeFile(join(root, 'bye.txt'), '# Bye\nSay bye to the user.')
  return root
}

describe('draft jobs', () => {
  it('gives the worker the exact PlanDraft JSON schema and an example', async () => {
    const prompt = draftPrompt('# Spec', { name: 'bye.txt', hash: 'h' })
    expect(prompt).toContain(JSON.stringify(PLAN_DRAFT_JSON_SCHEMA, null, 2))
    expect(PLAN_DRAFT_JSON_SCHEMA).toMatchObject({ properties: { decisions: { type: 'array', items: { type: 'string' } } } })
    const example = JSON.parse(prompt.split('## Example')[1]!.split('```json')[1]!.split('```')[0]!)
    expect(PlanDraftSchema.safeParse(example).success).toBe(true)
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    await startDraftJob({ root, spec: 'bye.txt', agent: 'codex/gpt', backends: fakeBackends(runs), now: NOW })
    expect(runs.get('run_fake-1')!.prompt).toContain('"decisions"')
    expect(runs.get('run_fake-1')!.prompt).toContain('Say bye to the user.')
  })

  it('normalises object decisions into the stored strings and saves the draft', async () => {
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    const job = await startDraftJob({ root, spec: 'bye.txt', agent: 'codex/gpt', backends: fakeBackends(runs), now: NOW })
    expect(job.status).toBe('running')
    finish(runs, 'run_fake-1', answer({ decisions: [{ question: 'Wave or bow?', options: ['wave', 'bow'], recommendation: 'wave' }, 'Plain one'] }))
    const done = await advanceDraftJob(root, job.id, fakeBackends(runs), NOW)
    expect(done).toMatchObject({ status: 'completed', draftId: 'bye-plan' })
    expect((await loadDraft(root, 'bye-plan')).decisions).toEqual(['Wave or bow? — options: wave; bow; recommendation: wave', 'Plain one'])
    expect((await loadDraft(root, 'bye-plan')).source).toMatchObject({ name: 'bye.txt' })
  })

  it('keeps an invalid answer as needs_repair with findings and the raw answer, never dropping it', async () => {
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    const job = await startDraftJob({ root, spec: 'bye.txt', agent: 'codex/gpt', backends: fakeBackends(runs), now: NOW })
    const bad = answer({ tasks: [{ ...task, class: 'backend' }], decisions: [42] })
    finish(runs, 'run_fake-1', bad)
    const kept = await advanceDraftJob(root, job.id, fakeBackends(runs), NOW)
    expect(kept.status).toBe('needs_repair')
    expect(kept.findings?.map((f) => f.path)).toEqual(['tasks[0].class', 'decisions[0]'])
    expect(await draftJobAnswer(root, kept)).toBe(bad)
    await expect(loadDraft(root, 'bye-plan')).rejects.toThrow('not_found')
    expect(checkDraftAnswer('Sure! {"id": ')).toMatchObject({ ok: false, findings: [{ code: 'invalid_json' }] })
  })

  it('survives a host restart: the job is on disk and a fresh process finishes it', async () => {
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    const job = await startDraftJob({ root, spec: 'bye.txt', agent: 'codex/gpt', backends: fakeBackends(runs), now: NOW })
    expect((await advanceDraftJobs(root, fakeBackends(runs), NOW))[0]).toMatchObject({ id: job.id, status: 'running' })
    // The host is gone; only the files and the worker's run remain.
    finish(runs, 'run_fake-1', answer())
    const restarted = fakeBackends(runs)
    expect((await listDraftJobs(root)).map((j) => [j.id, j.status])).toEqual([[job.id, 'running']])
    await advanceDraftJobs(root, restarted, new Date(NOW.getTime() + 60_000))
    expect(await loadDraftJob(root, job.id)).toMatchObject({ status: 'completed', draftId: 'bye-plan', attempts: [{ runId: 'run_fake-1', outcome: 'completed' }] })
  })

  it('repairs a bad answer with a follow-up run that sees the findings and the raw answer', async () => {
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    const backends = fakeBackends(runs)
    const job = await startDraftJob({ root, spec: 'bye.txt', agent: 'codex/gpt', backends, now: NOW })
    finish(runs, 'run_fake-1', answer({ decisions: [['nested']] }))
    expect((await advanceDraftJob(root, job.id, backends, NOW)).status).toBe('needs_repair')
    const repairing = await repairDraftJob({ root, id: job.id, backends, now: NOW })
    expect(repairing).toMatchObject({ status: 'running', attempts: [{ kind: 'draft' }, { kind: 'repair', runId: 'run_fake-2' }] })
    expect(repairing.findings).toBeUndefined()
    const prompt = runs.get('run_fake-2')!.prompt
    expect(prompt).toContain('`decisions[0]`')
    expect(prompt).toContain('"nested"')
    expect(prompt).toContain('"decisions"')
    finish(runs, 'run_fake-2', `\`\`\`json\n${answer({ decisions: ['nested'] })}\n\`\`\``)
    expect(await advanceDraftJob(root, job.id, backends, NOW)).toMatchObject({ status: 'completed', draftId: 'bye-plan' })
    expect((await loadDraft(root, 'bye-plan')).decisions).toEqual(['nested'])
    const files = await readdir(join(root, '.orchestration', 'draft-runs', job.id))
    expect(files.sort()).toEqual(['answer-1.txt', 'answer-2.txt', 'job.json', 'prompt-1.md', 'prompt-2.md'])
  })

  it('recovers a completed pre-job draft run whose answer was dropped, once', async () => {
    const root = await repoWithSpec()
    const runs = new Map<string, FakeRun>()
    const request = join(root, '.orchestration', 'draft-runs', 'request-1758700000000-abc.md')
    await mkdir(join(root, '.orchestration', 'draft-runs'), { recursive: true })
    await writeFile(request, `# Draft a plan graph\n\nSource must be ${JSON.stringify({ name: 'bye.txt', hash: 'abc123' })}. Ask no questions.`)
    const addRun = async (runId: string, promptFile: string, text: string) => {
      runs.set(runId, { terminal: true, status: 'completed', answer: text, prompt: '' })
      await mkdir(join(root, '.orchestration', 'runs', runId), { recursive: true })
      await writeFile(join(root, '.orchestration', 'runs', runId, 'args.json'), JSON.stringify({ promptFile, agent: 'codex/gpt-6-luna' }))
    }
    await addRun('run_codex-muerinmo8k16', request, answer({ decisions: [{ question: 'Q' }], tasks: [{ ...task, kind: 'build' }] }))
    await addRun('run_codex-saved', request, answer({ id: 'already-saved' }))
    await saveDraft(root, JSON.parse(answer({ id: 'already-saved' })))
    await addRun('run_codex-task', join(root, 'contract.md'), answer({ id: 'not-a-draft' }))
    const recovered = await recoverDraftOrphans(root, fakeBackends(runs), NOW)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toMatchObject({ status: 'needs_repair', recoveredFrom: 'run_codex-muerinmo8k16', agent: 'codex/gpt-6-luna', source: { name: 'bye.txt', hash: 'abc123' } })
    expect(recovered[0]!.findings?.map((f) => f.path)).toEqual(['tasks[0].kind'])
    expect(await draftJobAnswer(root, recovered[0]!)).toContain('"build"')
    expect(await recoverDraftOrphans(root, fakeBackends(runs), NOW)).toEqual([])
  })
})
