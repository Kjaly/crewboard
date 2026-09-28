import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type Backends, type RunBackend, getTaskShow, initPlan, loadDraft, loadPlan, newTask, nodeExec, updatePlan } from '@crewboard/core'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools, toDshTool, toLosslessJson } from '../src/host/tools.js'
import { OrchestraService as Service } from '../src/host/service.js'

const NOW = new Date('2026-09-22T12:00:00Z')

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'orch-tools-'))
  await initPlan(root, 'goal', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push({ ...newTask({ id: 'b', title: 'B' }), runs: [{ runId: 'run_dsh-b', agent: 'dsh', startedAt: '2026-09-22T11:59:00Z' }] })
    return p
  })
  const calls: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => 'run_dsh-new',
    events: async () => [
      { ts: '2026-09-22T11:59:10Z', type: 'turn_started', data: { turn: 1, text: 'go' } },
      { ts: '2026-09-22T11:59:20Z', type: 'tool_started', data: 'Read file' },
    ],
    status: async () => ({ status: 'running', terminal: false, exitCode: null }),
    steer: async (id) => {
      calls.push(`steer ${id}`)
    },
    cancel: async (id) => {
      calls.push(`cancel ${id}`)
    },
  }
  const backends: Backends = { forAgent: async () => backend }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const tools = orchestraTools({ service, repos: [root], backendsFor: () => backends, env: {}, home: root, now: () => NOW })
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }
  return { root, calls, tools, tool, backend }
}

describe('orchestra tools', () => {
  it('exposes the draft tool with JSON Schema parameters', async () => {
    const { tools } = await setup()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'orchestra_attention',
      'orchestra_close',
      'orchestra_decision',
      'orchestra_decision_answer',
      'orchestra_decision_prepare',
      'orchestra_draft_job_repair',
      'orchestra_draft_jobs',
      'orchestra_events',
      'orchestra_plan',
      'orchestra_plan_draft',
      'orchestra_run',
      'orchestra_steer',
      'orchestra_stop',
      'orchestra_task',
      'orchestra_task_upsert',
      'orchestra_trace',
      'orchestra_verify',
    ])
    for (const t of tools) expect(t.parameters).toMatchObject({ type: 'object', additionalProperties: false })
    const def = toDshTool(tools[0] as (typeof tools)[number])
    expect(def.output.render({}, { a: 1 })).toEqual([{ type: 'text', text: '{\n  "a": 1\n}' }])
  })

  // vr1: the chat gets the same three actions as `orch verify`; acceptance stays out of reach.
  it('orchestra_verify takes, finishes and returns a check', async () => {
    const { root, tool, tools } = await setup()
    const verifySchema = tools.find((item) => item.name === 'orchestra_verify')?.parameters as { properties?: { action?: { enum?: string[] }; verdict?: { enum?: string[] } } }
    expect(verifySchema.properties?.action?.enum).toContain('attest')
    expect(verifySchema.properties?.verdict?.enum).toEqual(['result', 'negative', 'disputed'])
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'take' })).rejects.toMatchObject({ code: 'not_in_review' })
    await updatePlan(root, (p) => {
      const b = p.tasks.find((t) => t.id === 'b')!
      b.status = 'in_review'
      b.runs[0]!.finishedAt = '2026-09-22T11:59:30Z'
      b.runs[0]!.outcome = 'completed'
      return p
    })
    expect(await tool('orchestra_verify').execute({ task: 'b', action: 'take' })).toMatchObject({ check: { state: 'checking', by: 'orchestrator' } })
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'done' })).rejects.toThrow('note is required')
    // B10: the run left no report and no changed file — done names the verdict and wants a deliberate yes.
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'done', note: 'gates green' })).rejects.toThrow(/"kind":"disputed".*confirm: true/)
    expect(await tool('orchestra_verify').execute({ task: 'b', action: 'done', note: 'gates green', confirm: true })).toMatchObject({ check: { state: 'checked', note: 'gates green' }, verdict: { kind: 'disputed', files: 0 } })
    // A repeated take leaves checked work with the person; only reopen takes it back.
    expect(await tool('orchestra_verify').execute({ task: 'b', action: 'take' })).toMatchObject({ alreadyChecked: true, check: { state: 'checked' } })
    expect(await tool('orchestra_verify').execute({ task: 'b', action: 'reopen' })).toMatchObject({ check: { state: 'checking' } })
    await writeFile(join(root, 'attestation.md'), 'Result: received\nCurrent independent proof.\n')
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'attest', verdict: 'result', report: 'attestation.md', note: 'checked independently' })).rejects.toMatchObject({ code: 'attestation_not_ready' })
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'accept' })).rejects.toThrow('action must be start, take, reopen, done, return or checks')
    // A return relaunches through the contract, like a human relaunch: without one it is refused.
    await expect(tool('orchestra_verify').execute({ task: 'b', action: 'return', note: 'tests red' })).rejects.toMatchObject({ code: 'no_contract' })
  })

  it('orchestra_close refuses unfinished work without accepting it', async () => {
    const { root, tool } = await setup()
    await expect(tool('orchestra_close').execute({ task: 'b' })).rejects.toThrow('Automatic acceptance requires')
    expect((await loadPlan(root)).tasks.find((task) => task.id === 'b')?.status).toBe('ready')
  })

  // dc1: an answer the person already gave in chat is recorded — no second Accept; an open decision the
  // person wants investigated returns to the orchestrator's preparation.
  it('orchestra_decision_answer records the chat answer; orchestra_decision_prepare reopens preparation', async () => {
    const { root, tool } = await setup()
    await updatePlan(root, (p) => {
      p.tasks.push(
        { ...newTask({ id: 'd1', title: 'Pick a store', kind: 'decision' }), check: { state: 'checked', at: NOW.toISOString(), note: 'options' } },
        newTask({ id: 'dep', title: 'Uses the store', deps: ['d1'] }),
      )
      return p
    })
    await expect(tool('orchestra_decision_answer').execute({ task: 'd1', answer: 'sqlite', basis: '' })).rejects.toThrow('basis is required')
    await expect(tool('orchestra_decision_answer').execute({ task: 'b', answer: 'sqlite', basis: 'chat' })).rejects.toMatchObject({ code: 'not_decision' })
    expect(await tool('orchestra_decision_answer').execute({ task: 'd1', answer: 'sqlite', basis: 'user message "use sqlite"' })).toMatchObject({ task: 'd1', status: 'accepted', answer: 'sqlite', basis: 'user message "use sqlite"' })
    const plan = await loadPlan(root)
    expect(plan.tasks.find((t) => t.id === 'd1')?.notes.at(-1)?.event).toMatchObject({ kind: 'answered', answer: 'sqlite', basis: 'user message "use sqlite"', by: 'orchestrator' })
    // The repeat is a no-op; a different answer on the closed decision is refused.
    expect(await tool('orchestra_decision_answer').execute({ task: 'd1', answer: 'sqlite', basis: 'user message "use sqlite"' })).toMatchObject({ alreadyRecorded: true })
    await expect(tool('orchestra_decision_answer').execute({ task: 'd1', answer: 'postgres', basis: 'other' })).rejects.toMatchObject({ code: 'decision_conflict' })
    await expect(tool('orchestra_decision_prepare').execute({ task: 'd1', reason: 'rethink' })).rejects.toMatchObject({ code: 'decision_closed' })

    // An open decision goes back to preparation: check and start marks clear, the reason is recorded.
    await updatePlan(root, (p) => {
      p.tasks.push({ ...newTask({ id: 'd2', title: 'Pick a cache', kind: 'decision' }), check: { state: 'checked', at: NOW.toISOString(), note: 'options' }, started: { by: 'orchestrator', at: NOW.toISOString() } })
      return p
    })
    expect(await tool('orchestra_decision_prepare').execute({ task: 'd2', reason: 'the person asked to research latency first' })).toMatchObject({ task: 'd2', status: 'ready' })
    const d2 = (await loadPlan(root)).tasks.find((t) => t.id === 'd2')
    expect(d2?.check).toBeUndefined()
    expect(d2?.started).toBeUndefined()
    expect(d2?.notes.at(-1)?.event).toMatchObject({ kind: 'decision_prepare', reason: 'the person asked to research latency first', by: 'orchestrator' })
    await expect(tool('orchestra_decision_prepare').execute({ task: 'b', reason: 'x' })).rejects.toMatchObject({ code: 'not_decision' })
  })

  // rt1: the orchestrator's own work — start, then done with a report file; the kind of an open task may change.
  it('orchestra_verify starts and finishes a root task with a report, and task_upsert changes its kind', async () => {
    const { root, tool } = await setup()
    await tool('orchestra_task_upsert').execute({ id: 'i1', title: 'Integrate on the stand', kind: 'decision' })
    expect(await tool('orchestra_task_upsert').execute({ id: 'i1', kind: 'root' })).toMatchObject({ kind: 'root', status: 'ready' })
    await expect(tool('orchestra_run').execute({ task: 'i1' })).rejects.toMatchObject({ code: 'root' })
    expect(await tool('orchestra_verify').execute({ task: 'i1', action: 'start' })).toMatchObject({ started: { by: 'orchestrator' } })
    await writeFile(join(root, 'report.md'), 'Result: received\n- [x] stand answers 200\n')
    await expect(tool('orchestra_verify').execute({ task: 'i1', action: 'done', note: 'n', report: '../outside.md' })).rejects.toThrow('inside the repo')
    expect(await tool('orchestra_verify').execute({ task: 'i1', action: 'done', note: 'stand integrated', report: 'report.md' })).toMatchObject({ status: 'in_review', check: { state: 'checked', report: '.orchestration/reports/main/i1.md' } })
    await expect(tool('orchestra_verify').execute({ task: 'i1', action: 'take' })).rejects.toMatchObject({ code: 'own_work' })
  })

  it('stores a chat draft and returns findings without approving it', async () => {
    const { root, tool } = await setup()
    const result = await tool('orchestra_plan_draft').execute({ draft: { id: 'chat-draft', goal: 'A', source: 'chat', lanes: ['core'], tasks: [{ id: 'a', title: 'A', lane: 'core', class: 'code', kind: 'implement', deps: ['missing'], contract: '', acceptance: [], sources: ['chat'] }], decisions: [] } })
    expect(result).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ code: 'missing_dependency' })]) })
    expect(await loadDraft(root, 'chat-draft')).toMatchObject({ goal: 'A' })
    expect((await loadPlan(root)).goal).toBe('goal')
  })

  it('gives the chat agent the exact PlanDraft schema, normalises object decisions and reports refusals as findings', async () => {
    const { root, tool } = await setup()
    const draftTool = tool('orchestra_plan_draft')
    expect(draftTool.parameters).toMatchObject({ properties: { draft: { type: 'object', required: expect.arrayContaining(['decisions']), properties: { decisions: { items: { type: 'string' } }, tasks: { items: { properties: { class: { enum: ['code', 'design', 'review', 'research'] } } } } } } } })
    expect(draftTool.description).toContain('"decisions":["Should the greeting be localised?"]')
    await draftTool.execute({ draft: { id: 'chat-draft', goal: 'A', source: 'chat', lanes: [], tasks: [], decisions: [{ title: 'Pick a name', options: ['a', 'b'] }] } })
    expect((await loadDraft(root, 'chat-draft')).decisions).toEqual(['Pick a name — options: a; b'])
    await expect(draftTool.execute({ draft: { id: 'bad', goal: 'A', source: 'chat', lanes: [], tasks: [{ id: 'x' }], decisions: [] } })).rejects.toThrow(/nothing was stored.*"path":"tasks\[0\]\.title"/)
  })

  // dsh's snapshotJsonValue rejects these and fails the whole tool call («value is not lossless JSON»).
  const lossy = (v: unknown, path = '$'): string[] => {
    if (v === undefined) return [path]
    if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0) ? [] : [path]
    if (v === null || typeof v !== 'object') return []
    const proto = Object.getPrototypeOf(v)
    if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return [path]
    return Object.entries(v).flatMap(([k, x]) => lossy(x, `${path}.${k}`))
  }

  it('returns lossless JSON from every read tool, even for a small plan without a split suggestion', async () => {
    const { tool } = await setup()
    for (const name of ['orchestra_plan', 'orchestra_attention']) expect(lossy(await tool(name).execute({})), name).toEqual([])
  })

  it('keeps the service snapshot free of undefined plan fields', async () => {
    const { root } = await setup()
    const service = new Service({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => ({ forAgent: async () => { throw new Error('unused') } }), now: () => NOW })
    await service.refresh(root)
    expect(lossy(service.snapshot().repos[0]?.plans)).toEqual([])
  })

  it('drops undefined and non-finite numbers at the tool boundary', () => {
    expect(toLosslessJson({ a: undefined, b: Number.NaN, c: 1, d: [undefined] })).toEqual({ b: null, c: 1, d: [null] })
    expect(toLosslessJson(undefined)).toBeNull()
  })

  // ts1: the orchestrator reads a task whole — the same structure as `crewboard task show --json`.
  it('orchestra_task returns the task show structure and refuses a missing task with a sentence', async () => {
    const { root, tool } = await setup()
    const shown = await tool('orchestra_task').execute({ task: 'b' })
    expect(shown).toMatchObject({ id: 'b', title: 'B', planId: 'main', mergeState: { state: 'none' }, lastRun: { runId: 'run_dsh-b', agent: 'dsh' }, checks: [] })
    const backends: Backends = { forAgent: async () => ({ events: async () => [{ ts: '2026-09-22T11:59:10Z', type: 'turn_started', data: { turn: 1, text: 'go' } }, { ts: '2026-09-22T11:59:20Z', type: 'tool_started', data: 'Read file' }] }) as unknown as RunBackend }
    expect(shown).toEqual(toLosslessJson(await getTaskShow(root, 'b', backends, nodeExec)))
    await expect(tool('orchestra_task').execute({ task: 'zzz' })).rejects.toThrow('No task zzz.')
  })

  it('reads the plan, events and trace of a run', async () => {
    const { tool } = await setup()
    expect(await tool('orchestra_plan').execute({})).toMatchObject({ goal: 'goal', tasks: [{ id: 'b', status: 'running' }] })
    expect(await tool('orchestra_events').execute({ task: 'b' })).toEqual([{ ts: '2026-09-22T11:59:20Z', kind: 'action', text: 'Read file' }])
    expect(await tool('orchestra_trace').execute({ task: 'b' })).toMatchObject({ totals: { turns: 1, toolCalls: 1 } })
  })

  // The orchestrator gets the legacy compact events; the browser's bounded display and tool metadata never ship.
  it('projects compact machine events from orchestra_events and orchestra_task', async () => {
    const { tool, backend } = await setup()
    backend.events = async () => [
      { ts: '2026-09-22T11:59:20Z', type: 'tool_started', data: { tool: 'write', status: 'running', input: { file_path: '/wt/a.ts' } } },
      { ts: '2026-09-22T11:59:30Z', type: 'answer_delta', data: 'line one\nline two' },
    ]
    const events = (await tool('orchestra_events').execute({ task: 'b' })) as Array<Record<string, unknown>>
    expect(events).toEqual([
      { ts: '2026-09-22T11:59:20Z', kind: 'file', text: 'a.ts' },
      { ts: '2026-09-22T11:59:30Z', kind: 'message', text: 'line one line two' },
    ])
    expect(events[0]).not.toHaveProperty('tool')
    expect(events[1]).not.toHaveProperty('display')
    const shown = (await tool('orchestra_task').execute({ task: 'b' })) as { events: Array<Record<string, unknown>> }
    expect(shown.events).toEqual(events)
  })

  it('upserts tasks and decisions but never accepts', async () => {
    const { root, tool } = await setup()
    await tool('orchestra_task_upsert').execute({ id: 'c', title: 'C', deps: ['b'] })
    await tool('orchestra_decision').execute({ id: 'approve', title: 'Утвердить план' })
    const plan = await loadPlan(root)
    expect(plan.tasks.map((t) => [t.id, t.kind, t.status])).toEqual([
      ['b', 'implement', 'ready'],
      ['c', 'implement', 'ready'],
      ['approve', 'decision', 'ready'],
    ])
    await expect(tool('orchestra_task_upsert').execute({ id: 'c', status: 'accepted' })).rejects.toThrow(/human/)
  })

  // ct1 (B16, B21): class from the chat, no acceptance in the enum, contracts from the one template.
  it('offers class and no acceptance statuses in the task tool', async () => {
    const { tool } = await setup()
    const props = (tool('orchestra_task_upsert').parameters as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.status?.enum).toEqual(['backlog', 'ready'])
    expect(props.class?.enum).toEqual(['code', 'design', 'review', 'research'])
    await expect(tool('orchestra_task_upsert').execute({ id: 'c', title: 'C', class: 'docs' })).rejects.toThrow(/unknown class/)
  })

  it('writes a contract from result and checks, and says what a contract lacks', async () => {
    const { root, tool } = await setup()
    const made = await tool('orchestra_task_upsert').execute({ id: 'c', title: 'Add greet', class: 'design', result: 'Add src/greet.ts', checks: ['pnpm test'], sources: ['spec.md §2'] }) as Record<string, unknown>
    expect(made).toMatchObject({ id: 'c', class: 'design', contract: '.orchestration/contracts/main/c.md' })
    expect(made).not.toHaveProperty('warnings')
    const contract = await readFile(join(root, '.orchestration/contracts/main/c.md'), 'utf8')
    expect(contract).toContain('<checks>\n- pnpm test\n</checks>')
    expect(contract).toContain('`Result: received`')

    expect(await tool('orchestra_task_upsert').execute({ id: 'd', title: 'D' })).toMatchObject({ needsContract: true, notice: expect.stringContaining('crewboard task set d --template') })

    await writeFile(join(root, 'sketch.md'), 'Add src/e.ts\n')
    const soft = await tool('orchestra_task_upsert').execute({ id: 'e', title: 'E', contract: 'sketch.md' }) as { warnings: string[] }
    expect(soft.warnings).toHaveLength(2)
    expect(soft.warnings[0]).toMatch(/^Warning: the contract of e has no checks/)
    expect(soft.warnings[1]).toMatch(/^Warning: the contract of e does not ask for the result line/)
  })

  it('steers and stops through the backend and rejects unknown repos', async () => {
    const { calls, tool } = await setup()
    await tool('orchestra_steer').execute({ task: 'b', message: 'use vitest' })
    await tool('orchestra_stop').execute({ task: 'b' })
    expect(calls).toEqual(['steer run_dsh-b', 'cancel run_dsh-b'])
    await expect(tool('orchestra_plan').execute({ repo: '/not/configured' })).rejects.toThrow(/not a dsh workspace or a Crewboard repository.*crewboard repo add \/not\/configured/)
  })

  it('reports launch refusals as tool errors with the reason', async () => {
    const { tool } = await setup()
    await expect(tool('orchestra_run').execute({ task: 'b', agent: 'dsh' })).rejects.toThrow(/already running/)
  })
})
