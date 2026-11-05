import { execFileSync } from 'node:child_process'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildTree, flatten } from '../src/model/project.js'
import type { NewEvent } from '../src/model/types.js'
import { createEventStore } from '../src/store/event-store.js'
import { createInbox } from '../src/store/inbox.js'
import { runsDir } from '../src/store/paths.js'
import { createSupervisor, gitWorktree, withSetup } from '../src/supervisor.js'
import { createPool } from '../src/workers/pool.js'
import { createFakeBackend } from './fake-backend.js'
import type { ProjectContext } from '../src/app.js'
import { createLeadCommands } from '../src/lead/commands.js'
import { requestAsOwner, decideRequest } from '../src/requests.js'
import { createStepsReader } from '../src/workers/steps.js'
import { createAgents } from '../src/workers/agents.js'

async function gitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cb-sup-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  git('init', '-q', '-b', 'main')
  await writeFile(join(dir, 'README.md'), '# demo\n')
  git('add', '.')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
  return dir
}

async function setup(fake = createFakeBackend(), repo?: string, agents?: ReturnType<typeof createAgents>) {
  const root = repo ?? (await gitRepo())
  const store = createEventStore(root)
  const pool = createPool({ backendFor: async () => fake.backend, runsDir: runsDir(root), repo: root })
  const sup = createSupervisor({ repo: root, store, pool, now: () => new Date(), worktree: gitWorktree, ...(agents ? { agents } : {}) })
  return { root, store, pool, sup, fake }
}

const goal = async (store: ReturnType<typeof createEventStore>) => {
  await store.writeMeta({ goalId: 'g', title: 'Кухня', createdAt: new Date().toISOString(), leadLastSeen: new Date().toISOString() })
  await store.append('g', { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Кухня', criteria: [] })
}
const assign = (id: string, extra: Partial<Extract<NewEvent, { type: 'assigned' }>> = {}): NewEvent => ({
  type: 'assigned', goalId: 'g', assignmentId: id, actor: 'lead', parentId: 'g', title: id, criteria: [], resultKind: 'local', provider: 'claude', after: [], ...extra,
})
const statusOf = async (store: ReturnType<typeof createEventStore>, id: string) =>
  flatten(buildTree(await store.read('g'), new Date(), new Date())).find((n) => n.id === id)?.status
const typesOf = async (store: ReturnType<typeof createEventStore>, id: string) => (await store.read('g')).filter((e) => e.assignmentId === id).map((e) => e.type)

describe('supervisor', () => {
  const resultSchema = { type: 'object', properties: { verdict: { type: 'string', enum: ['pass', 'fail'] } }, required: ['verdict'], additionalProperties: false }

  it('keeps a validated result in the inbox and status and gives it to after dependants', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: JSON.stringify({ handback: '<crewboard-report>Checked</crewboard-report>', result: { verdict: 'pass' } }) }, { hold: true })
    await goal(store)
    await store.append('g', assign('review', { schema: resultSchema }))
    await store.append('g', assign('next', { after: ['review'] }))
    await sup.tick()
    expect(fake.launches[0]?.schema).toMatchObject({ properties: { result: { anyOf: [resultSchema, { type: 'null' }] } } })
    await sup.tick()
    expect((await createInbox(store).pending()).find((e) => e.type === 'reported')).toMatchObject({ summary: 'Checked', result: { verdict: 'pass' } })
    expect(flatten(buildTree(await store.read('g'), new Date(), new Date())).find((n) => n.id === 'review')).toMatchObject({ schema: resultSchema, result: { verdict: 'pass' } })
    expect(fake.runs).toHaveLength(1)
    await sup.close('g', 'review', 'accepted')
    await sup.tick()
    expect(fake.runs[1]?.prompt).toContain('"verdict":"pass"')
    expect(fake.runs[1]?.prompt).toContain('review')
  })

  it('does not expose a superseded result after reopening, including to forced after dependants', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-report>{"verdict":"pass"}</crewboard-report>' }, { hold: true }, { hold: true })
    await goal(store)
    await store.append('g', assign('review', { schema: resultSchema }))
    await sup.tick()
    await sup.tick()
    await sup.close('g', 'review', 'accepted')
    await store.append('g', { type: 'reopened', goalId: 'g', assignmentId: 'review', actor: 'lead', note: 'check again' })
    expect(flatten(buildTree(await store.read('g'), new Date(), new Date())).find((n) => n.id === 'review')).not.toHaveProperty('result')
    await sup.deliver('g', 'review', 'check again')
    await store.append('g', assign('next', { after: ['review'] }))
    await store.append('g', { type: 'unblocked', goalId: 'g', assignmentId: 'next', actor: 'lead' })
    await sup.tick()
    expect(fake.runs[2]?.prompt).not.toContain('"result":{"verdict":"pass"}')
    expect(fake.runs[2]?.prompt).not.toContain('Accepted: accepted')
  })

  it.each([
    ['missing', '<crewboard-report>done</crewboard-report>', /JSON|missing/i],
    ['malformed', '<crewboard-report>{"verdict":</crewboard-report>', /JSON/i],
    ['invalid', '{"handback":"<crewboard-report>done</crewboard-report>","result":{"verdict":"maybe"}}', /schema|allowed/i],
    ['too large', JSON.stringify({ handback: '<crewboard-report>done</crewboard-report>', result: { verdict: 'pass', padding: 'я'.repeat(33_000) } }), /size|bytes|large|limit/i],
  ])('reports an explicit error for a %s structured result', async (_name, final, error) => {
    const { store, sup, fake } = await setup()
    fake.script({ final })
    await goal(store)
    await store.append('g', assign('review', { schema: resultSchema }))
    await store.append('g', assign('next', { after: ['review'] }))
    await sup.tick()
    await sup.tick()
    const report = (await createInbox(store).pending()).find((e) => e.type === 'reported')
    expect(report).toMatchObject({ schemaError: expect.stringMatching(error) })
    expect(report).not.toHaveProperty('result')
    expect(flatten(buildTree(await store.read('g'), new Date(), new Date())).find((n) => n.id === 'review')).toMatchObject({ schemaError: expect.stringMatching(error) })
    await sup.close('g', 'review', 'accepted with known error')
    fake.script({ hold: true })
    await sup.tick()
    expect(fake.runs[1]?.prompt).toContain('schemaError')
  })

  it.each([
    ['valid', '{"verdict":"pass"}', '"verdict":"pass"'],
    ['invalid', '{"verdict":"maybe"}', '"schemaError":'],
  ])('accepts legacy control blocks with a schema and returns a %s child result to the parent', async (_name, result, expected) => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-question>Need context?</crewboard-question>' }, { final: '<crewboard-split>\n- Child\n</crewboard-split>' }, { final: `<crewboard-report>${result}</crewboard-report>` }, { hold: true })
    await goal(store)
    await store.append('g', assign('parent', { schema: resultSchema }))
    await sup.tick()
    await sup.tick()
    expect((await store.read('g')).filter((e) => e.type === 'reported')).toHaveLength(0)
    await sup.deliver('g', 'parent', 'context')
    await sup.tick()
    const split = (await store.read('g')).find((e) => e.type === 'reported')
    expect(split).toMatchObject({ split: true })
    expect(split).not.toHaveProperty('schemaError')
    await sup.tick()
    await sup.tick()
    expect(fake.runs.at(-1)?.prompt).toContain(expected)
    const child = (await store.read('g')).find((e) => e.type === 'assigned' && e.actor === 'worker')
    expect(child).toMatchObject({ schema: resultSchema })
  })

  it.each([
    ['bad type', { type: 'nonsense' }, /schema/i],
    ['bad keyword', { type: 'object', required: 'verdict' }, /schema/i],
    ['non-object result', { type: 'string' }, /object/i],
    ['async schema', { type: 'object', $async: true }, /async/i],
    ['too large', { type: 'object', description: 'я'.repeat(9_000) }, /size|bytes|large|limit/i],
    ['external ref', { type: 'object', properties: { verdict: { $ref: 'https://example.com/result.json' } } }, /schema|ref/i],
  ])('rejects an invalid assignment schema before recording or launching it: %s', async (_name, schema, error) => {
    const { root, store, sup, fake } = await setup()
    await goal(store)
    const ctx: ProjectContext = {
      repo: root, store, agents: (await import('../src/workers/agents.js')).builtinAgents, supervisor: sup, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => sup.tick(),
    }
    await expect(createLeadCommands(async () => ctx, () => new Date()).assign({ project: root, goalId: 'g', title: 'Work', criteria: [], resultKind: 'answer', provider: 'codex', schema })).rejects.toThrow(error)
    expect((await store.read('g')).filter((e) => e.type === 'assigned')).toHaveLength(0)
    expect(fake.launches).toHaveLength(0)
  })

  it('returns an assignment while its worktree is still being prepared', async () => {
    const { root, store, pool, fake } = await setup()
    await goal(store)
    let release!: () => void
    let started!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const preparing = new Promise<void>((resolve) => { started = resolve })
    const supervisor = createSupervisor({ repo: root, store, pool, now: () => new Date(), worktree: async () => { started(); await blocked; return root } })
    const ctx: ProjectContext = {
      repo: root, store, agents: (await import('../src/workers/agents.js')).builtinAgents, supervisor, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => supervisor.tick(),
    }
    try {
      const result = await Promise.race([
        createLeadCommands(async () => ctx, () => new Date()).assign({ project: root, goalId: 'g', title: 'Work', criteria: [], resultKind: 'branch', provider: 'codex' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
      ])
      expect(result).not.toBeNull()
      await preparing
      expect(fake.launches).toHaveLength(0)
    } finally { release() }
    await supervisor.tick()
    expect(fake.launches).toHaveLength(1)
  })

  it.each(['close', 'cancel'] as const)('notifies the lead when the last assignment ends by %s', async (action) => {
    const { store, sup } = await setup()
    const inbox = createInbox(store)
    await goal(store)
    await store.append('g', assign('a'))
    await store.append('g', assign('b'))
    const idle = async () => (await inbox.pending()).filter((e) => e.type === 'progress' && e.code === 'goal_idle')
    await sup.close('g', 'a', 'done')
    expect(await idle()).toHaveLength(0)
    if (action === 'close') await sup.close('g', 'b', 'done')
    else await sup.cancelTree('g', 'b', 'cancelled', 'owner')
    expect(await idle()).toHaveLength(1)
    await sup.close('g', 'g', 'done')
    expect(await idle()).toHaveLength(0)
    expect(await statusOf(store, 'g')).toBe('done')
  })

  it.each([
    ['normal', {}, 'gpt-6.1-sol', 'medium'],
    ['hard', { model: 'custom', effort: 'low' }, 'custom', 'low'],
    ['review', {}, 'opus', undefined],
  ] as const)('assigns the %s preset with explicit overrides taking priority', async (preset, overrides, model, effort) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-presets-'))
    const agents = createAgents({ CREWBOARD_HOME: home })
    const { store, sup, fake, root } = await setup(undefined, undefined, agents)
    fake.setFallback({ hold: true })
    await goal(store)
    const ctx: ProjectContext = {
      repo: root, store, agents, supervisor: sup, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => sup.tick(),
    }
    const commands = createLeadCommands(async () => ctx, () => new Date(), agents)
    expect((await commands.agents()).presets[preset]).toBeDefined()
    await commands.assign({ project: root, goalId: 'g', title: 'a', criteria: [], resultKind: 'local', preset, ...overrides })
    await sup.tick()
    expect(fake.launches.at(-1)?.model).toBe(model)
    expect(fake.launches.at(-1)?.effort).toBe(effort)
    await writeFile(join(home, 'agents.json'), JSON.stringify({ presets: { [preset]: false } }))
    await expect(commands.assign({ project: root, goalId: 'g', title: 'b', criteria: [], resultKind: 'local', preset })).rejects.toThrow(/disabled/)
  })

  it.each([
    ['local', 'network'],
    ['answer', undefined],
  ] as const)('ac1/a %s assignment from a preset with network access launches with access %s', async (resultKind, access) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-access-'))
    await writeFile(join(home, 'agents.json'), JSON.stringify({ presets: { net: { agent: 'codex', access: 'network' } } }))
    const agents = createAgents({ CREWBOARD_HOME: home })
    const { store, sup, fake, root } = await setup(undefined, undefined, agents)
    fake.setFallback({ hold: true })
    await goal(store)
    const ctx: ProjectContext = {
      repo: root, store, agents, supervisor: sup, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => sup.tick(),
    }
    await createLeadCommands(async () => ctx, () => new Date(), agents).assign({ project: root, goalId: 'g', title: 'a', criteria: [], resultKind, preset: 'net' })
    await sup.tick()
    expect(fake.launches.at(-1)?.access).toBe(access)
  })

  it.each([
    ['touch prepared', 'ran', undefined],
    ['echo broken lockfile >&2; exit 3', 'failed', /worktree setup failed.*broken lockfile/],
  ] as const)('ws1/branch work waits for the owner setup command `%s` on the host, then %s', async (command, outcome, reason) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-setup-'))
    const fake = createFakeBackend()
    const root = await gitRepo()
    await writeFile(join(home, 'agents.json'), JSON.stringify({ projects: { [root]: { setup: command } } }))
    const agents = createAgents({ CREWBOARD_HOME: home })
    const store = createEventStore(root)
    const pool = createPool({ backendFor: async () => fake.backend, runsDir: runsDir(root), repo: root })
    const sup = createSupervisor({ repo: root, store, pool, now: () => new Date(), worktree: withSetup(gitWorktree, async (repo) => agents.setupFor?.(repo)), agents })
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a', { resultKind: 'branch' }))
    await sup.tick()
    expect(fake.launches).toHaveLength(0)
    expect((await store.read('g')).find((e) => e.type === 'progress')).toMatchObject({ code: 'worktree_setup', detail: command })
    for (let i = 0; i < 100 && !(await typesOf(store, 'a')).includes('run_started'); i++) {
      await new Promise((r) => setTimeout(r, 50))
      await sup.tick()
    }
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended')
    if (outcome === 'ran') {
      expect(fake.launches).toHaveLength(1)
      await expect(access(join(fake.launches[0]?.cwd ?? '', 'prepared'))).resolves.toBeUndefined()
      expect(ended).toBeUndefined()
    } else {
      expect(fake.launches).toHaveLength(0)
      expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringMatching(reason ?? /./) })
    }
  })

  it.each([undefined, 'medium'])('resets the same agent effort to %s and leaves accepted queued work unstarted', async (defaultEffort) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-handoff-'))
    const agents = createAgents({ CREWBOARD_HOME: home })
    await writeFile(join(home, 'agents.json'), JSON.stringify({ agents: { codex: { effort: defaultEffort } } }))
    const { store, sup, fake, root } = await setup(undefined, undefined, agents)
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a', { provider: 'codex', effort: 'high', after: ['blocker'] }))
    const ctx: ProjectContext = {
      repo: root, store, agents, supervisor: sup, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => sup.tick(),
    }
    const request = async (provider: string, effort?: string | null) => {
      const { requestId } = await requestAsOwner(ctx, { goalId: 'g', assignmentId: 'a', action: 'handoff', provider, ...(effort !== undefined ? { effort } : {}) }, new Date())
      await decideRequest(ctx, { goalId: 'g', assignmentId: 'a', requestId, decision: 'accepted' }, new Date())
    }
    await request('claude')
    expect(fake.launches).toHaveLength(0)
    expect((await store.read('g')).findLast((e) => e.type === 'reassigned')).toMatchObject({ provider: 'claude', resolvedModel: 'sonnet' })
    await request('codex', 'high')
    await request('codex', null)
    expect((await store.read('g')).findLast((e) => e.type === 'reassigned')).not.toHaveProperty('effort')
    expect(fake.launches).toHaveLength(0)
    await store.append('g', { type: 'unblocked', goalId: 'g', assignmentId: 'a', actor: 'lead' })
    await sup.tick()
    expect(fake.launches.at(-1)?.model).toBe('gpt-6.1-sol')
    expect(fake.launches.at(-1)?.effort).toBe(defaultEffort)
    // Reset also works after a run starts; the old snapshot stays in its original run_started event.
    await request('codex', 'high')
    await request('codex', null)
    expect(fake.launches.at(-1)?.effort).toBe(defaultEffort)
    const starts = (await store.read('g')).filter((e) => e.type === 'run_started')
    expect(starts.at(-2)).toMatchObject({ effort: 'high' })
    expect(starts.at(-1)?.effort).toBe(defaultEffort)
  })

  it.each(['assign', 'launch', 'handoff', 'owner', 'accept'] as const)('validates selected and inherited model efforts before %s', async (action) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-agents-'))
    const file = join(home, 'agents.json')
    await writeFile(file, JSON.stringify({ agents: { codex: { models: [{ id: 'fast', efforts: ['low'] }] } } }))
    const agents = createAgents({ CREWBOARD_HOME: home })
    const { store, sup, fake, root } = await setup(undefined, undefined, agents)
    fake.setFallback({ hold: true })
    await goal(store)
    const ctx: ProjectContext = {
      repo: root, store, agents, supervisor: sup, inbox: createInbox(store), steps: createStepsReader(store, async () => fake.backend),
      exclusive: (fn) => fn(ctx), register: async () => {}, tickOnce: () => sup.tick(),
    }
    const commands = createLeadCommands(async () => ctx, () => new Date(), agents)
    if (action === 'assign') {
      await expect(commands.assign({ project: root, goalId: 'g', title: 'a', criteria: [], resultKind: 'local', provider: 'codex', model: 'fast', effort: 'high' })).rejects.toThrow()
      expect((await store.read('g')).some((e) => e.type === 'assigned')).toBe(false)
    } else if (action === 'launch') {
      await store.append('g', assign('a', { provider: 'codex', model: 'fast', effort: 'high' }))
      await sup.tick()
      expect(fake.runs).toHaveLength(0)
      expect((await createInbox(store).pending()).find((e) => e.type === 'run_ended')).toMatchObject({ outcome: 'failed' })
    } else {
      await store.append('g', assign('a', { provider: 'codex', model: 'fast', effort: 'low' }))
      await sup.tick()
      if (action === 'handoff') await expect(sup.reassign('g', 'a', 'codex', 'fast', 'high')).rejects.toThrow()
      if (action === 'owner') await expect(requestAsOwner(ctx, { goalId: 'g', assignmentId: 'a', action: 'handoff', provider: 'codex', effort: 'high' }, new Date())).rejects.toThrow()
      if (action === 'accept') {
        const { requestId } = await requestAsOwner(ctx, { goalId: 'g', assignmentId: 'a', action: 'handoff', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, new Date())
        await writeFile(file, JSON.stringify({ agents: { codex: { models: [{ id: 'gpt-6.1-sol', efforts: ['low'] }] } } }))
        await expect(decideRequest(ctx, { goalId: 'g', assignmentId: 'a', requestId, decision: 'accepted' }, new Date())).rejects.toThrow()
        expect((await store.read('g')).some((e) => e.type === 'request_decided')).toBe(false)
      }
      expect(fake.cancelled).toHaveLength(0)
      expect((await store.read('g')).some((e) => e.type === 'reassigned')).toBe(false)
    }
    const { agents: choices } = await commands.agents()
    expect(choices.find((a) => a.id === 'codex')?.models[0]?.efforts).toEqual(['low'])
  })

  it.each([
    [{ model: 'first', effort: 'medium' }, {}, { model: 'first', effort: 'medium' }, { model: 'second', effort: 'high' }],
    [{ model: 'first', effort: 'medium' }, { model: 'chosen', effort: 'low' }, { model: 'chosen', effort: 'low' }, { model: 'chosen', effort: 'low' }],
    [{ model: 'first' }, {}, { model: 'first', effort: undefined }, { model: 'second', effort: 'high' }],
  ])('snapshots launch choices from %j without reusing them as overrides', async (defaults, overrides, first, next) => {
    const home = await mkdtemp(join(tmpdir(), 'cb-agents-'))
    const file = join(home, 'agents.json')
    await writeFile(file, JSON.stringify({ agents: { codex: defaults } }))
    const { store, sup, fake } = await setup(undefined, undefined, createAgents({ CREWBOARD_HOME: home }))
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a', { provider: 'codex', ...overrides }))
    await sup.tick()
    const snapshot = async () => {
      const started = (await store.read('g')).findLast((e) => e.type === 'run_started')
      return { model: started?.model, effort: started?.effort }
    }
    expect(await snapshot()).toEqual(first)
    expect({ model: fake.launches[0]?.model, effort: fake.launches[0]?.effort }).toEqual(first)

    fake.finish(fake.runs[0]!.id, { final: '<crewboard-report>done</crewboard-report>' })
    await sup.tick()
    await writeFile(file, JSON.stringify({ agents: { codex: { model: 'second', effort: 'high' }, claude: { model: 'handoff', effort: 'max' } } }))
    await sup.deliver('g', 'a', 'Continue')
    expect(await snapshot()).toMatchObject(next)
    expect(fake.launches[1]).toMatchObject(next)

    await sup.reassign('g', 'a', 'claude')
    expect(await snapshot()).toMatchObject({ model: 'handoff', effort: 'max' })
    expect(fake.launches[2]).toMatchObject({ agent: 'claude/handoff', model: 'handoff', effort: 'max' })
  })

  it.each(['message', 'thought', 'command'] as const)('uses readable %s progress, preferring narration to later commands', async (kind) => {
    const { store, sup, fake, root } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    const run = fake.runs[0]!
    if (kind !== 'command') run.events.push({ ts: new Date().toISOString(), type: kind === 'message' ? 'answer_delta' : 'reasoning_summary', data: 'Looking for where the encryption key is stored' })
    run.events.push({ ts: new Date().toISOString(), type: 'tool_started', data: { callId: 'c1', tool: 'bash', status: 'running', input: { command: `/bin/zsh -lc "git -C ${root} grep -n key"` } } })
    await sup.tick()
    expect((await store.read('g')).findLast((e) => e.type === 'progress')).toMatchObject({ text: kind === 'command' ? 'git grep -n key' : 'Looking for where the encryption key is stored' })
    if (kind !== 'command') {
      run.events.push({ ts: new Date().toISOString(), type: 'tool_started', data: { callId: 'c2', tool: 'bash', status: 'running', input: { command: 'git status' } } })
      fake.finish(run.id, { final: '<crewboard-report>Checked</crewboard-report>' })
      await sup.tick()
      expect((await store.read('g')).findLast((e) => e.type === 'progress')).toMatchObject({ text: 'Looking for where the encryption key is stored' })
    }
  })

  it('launches a registered agent through its core id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cb-agents-'))
    await writeFile(join(home, 'agents.json'), JSON.stringify({ agents: { kimi: { label: 'Kimi', run: 'dsh', model: 'moonshot/kimi-k3' } } }))
    const { store, sup, fake } = await setup(undefined, undefined, createAgents({ CREWBOARD_HOME: home }))
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a', { provider: 'kimi' }))
    await sup.tick()
    expect(fake.runs[0]?.agent).toBe('dsh/moonshot/kimi-k3')
  })

  it('leaves queued work waiting while the agent registry file is broken, and starts it once fixed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'cb-agents-'))
    const file = join(home, 'agents.json')
    await writeFile(file, '{ "agents": { "kimi": ')
    const { store, sup, fake, pool, root } = await setup(undefined, undefined, createAgents({ CREWBOARD_HOME: home }))
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await store.append('g', assign('b'))
    await sup.tick()
    await sup.tick()
    expect(fake.runs.length).toBe(0)
    expect(await typesOf(store, 'a')).toEqual(['assigned'])
    expect(await statusOf(store, 'a')).toBe('queued')
    const pending = await createInbox(store).pending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ assignmentId: 'g', type: 'progress', code: 'launch_registry', detail: expect.stringContaining(file) })
    const restarted = createSupervisor({ repo: root, store, pool, now: () => new Date(), worktree: gitWorktree, agents: createAgents({ CREWBOARD_HOME: home }) })
    await restarted.tick()
    expect(await createInbox(store).pending()).toHaveLength(1)
    await writeFile(file, '{ "agents": {} }')
    await sup.tick()
    expect(fake.runs.length).toBe(2)
  })

  it('records a failed run for an agent no longer registered', async () => {
    const { store, sup, fake } = await setup()
    await goal(store)
    await store.append('g', assign('a', { provider: 'gone' }))
    await sup.tick()
    expect(fake.runs.length).toBe(0)
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('gone') })
  })

  it('includes goal and completed dependency context in the first prompt', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await store.writeMeta({ goalId: 'g', title: 'Goal', createdAt: new Date().toISOString() })
    await store.append('g', { type: 'goal_started', goalId: 'g', assignmentId: 'g', actor: 'lead', title: 'Goal', criteria: ['goal criterion'], quote: 'owner goal words' })
    await store.append('g', assign('a', { branch: 'feature/a' }))
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'a', actor: 'lead', summary: 'dependency result' })
    await store.append('g', assign('b', { after: ['a'], quote: 'owner assignment words' }))
    await sup.tick()
    const prompt = fake.runs[0]!.prompt
    for (const text of ['goal criterion', 'owner goal words', 'owner assignment words', 'dependency result', 'feature/a']) expect(prompt).toContain(text)
  })

  it('gives a queued assignment the clarifications sent while it waited', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await store.append('g', assign('b', { after: ['a'] }))
    await sup.tick()
    await store.append('g', { type: 'steered', goalId: 'g', assignmentId: 'b', actor: 'lead', text: 'use metric units' })
    expect(await sup.deliver('g', 'b', 'Clarification from the lead: use metric units')).toBe('recorded')
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'a', actor: 'lead', summary: 'ok' })
    await sup.tick()
    const run = fake.runs.find((r) => r.prompt.includes('Assignment: b'))
    expect(run?.prompt).toContain('use metric units')
  })

  it.each([
    ['answer', true],
    ['decision', true],
    ['local', false],
  ] as const)('launches %s work read-only: %s', async (resultKind, readOnly) => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a', { resultKind }))
    await sup.tick()
    expect(fake.runs[0]?.readOnly ?? false).toBe(readOnly)
  })

  it('starts queued work with the provider agent', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    const started = (await store.read('g')).find((e) => e.type === 'run_started')
    expect(started).toMatchObject({ assignmentId: 'a', agent: 'claude/sonnet' })
  })

  it('waits for `after` work to be done', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('x'))
    await store.append('g', assign('y', { after: ['x'] }))
    await sup.tick()
    expect(await typesOf(store, 'y')).toEqual(['assigned'])
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'x', actor: 'lead', summary: 'ok' })
    await sup.tick()
    expect(await typesOf(store, 'y')).toContain('run_started')
  })

  it('relays progress and a question, then waits for an answer', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ events: ['Пишет тесты. <crewboard-question>черновик</crewboard-question>'], final: '<crewboard-question>Шторка?\n\n- Да\n- Нет</crewboard-question>' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'progress', 'question', 'run_ended'])
    expect(await statusOf(store, 'a')).toBe('waiting_answer')
    const progress = (await store.read('g')).find((e) => e.type === 'progress')
    expect(progress).toMatchObject({ text: expect.not.stringContaining('<crewboard-') })
  })

  it.each([
    ['Bearer token-123 sk-test_secret API_KEY=hidden', 'Bearer [redacted] [redacted] API_KEY=[redacted]'],
    ['API_KEY="two words" other_key=secret KEY=bare', 'API_KEY=[redacted] other_key=[redacted] KEY=[redacted]'],
    [`${'x'.repeat(490)} Bearer ${'secret'.repeat(100)}`, `${'x'.repeat(490)} Bearer [r`],
  ])('keeps a bounded, redacted failure reason in the journal and inbox: %s', async (failureText, expected) => {
    const { store, sup, fake } = await setup()
    fake.script({ fail: 'worker_error', failureText })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ reason: 'worker_error', text: expected })
    expect((await createInbox(store).pending()).find((e) => e.type === 'run_ended')).toEqual(ended)
  })

  it.each(['answer', 'decision', 'local'] as const)('delivers the full %s result outside the report block', async (resultKind) => {
    const { store, sup, fake } = await setup()
    fake.script({ final: `${'a'.repeat(30_010)}\n<crewboard-report>Summary</crewboard-report>` })
    await goal(store)
    await store.append('g', assign('a', { resultKind }))
    await sup.tick()
    await sup.tick()
    const report = (await createInbox(store).pending()).find((e) => e.type === 'reported')
    expect(report).toMatchObject({ summary: 'Summary' })
    expect(report?.type === 'reported' && report.detail).toBe(resultKind === 'local' ? undefined : 'a'.repeat(30_000))
  })

  it('tells the lead when a run fails', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ fail: 'auth' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    const ended = (await createInbox(store).pending()).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ outcome: 'failed', reason: 'auth' })
  })

  it('records a launch the backend refuses as a failed run, tells the lead once and does not retry', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ refuse: 'Claude API-only policy refused this launch: anthropic_api_key_missing' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    expect(fake.runs.length).toBe(0)
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'run_ended'])
    const ended = (await createInbox(store).pending()).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('anthropic_api_key_missing') })
  })

  it('relaunches a refused launch when the lead steers it', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ refuse: 'no key' }, { final: '<crewboard-report>ok</crewboard-report>' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    expect(await sup.deliver('g', 'a', 'ключ добавлен, повтори')).toBe('relaunched')
    expect(fake.runs.length).toBe(1)
  })

  it('keeps the report of a run that ended just before a message reached it', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-report>first result</crewboard-report>' }, { hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    // The run already ended in its backend, but no tick has read it yet.
    expect(await sup.deliver('g', 'a', 'one more thing')).toBe('relaunched')
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'reported', 'run_ended', 'run_started'])
    expect(fake.runs[1]!.prompt).toContain('first result')
  })

  it('keeps the rest of the project moving when one run cannot be read', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ hold: true, brokenFeed: true }, { hold: true })
    await goal(store)
    await store.append('g', assign('broken'))
    await sup.tick()
    await store.append('g', assign('next'))
    await sup.tick()
    expect(await typesOf(store, 'next')).toContain('run_started')
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended' && e.assignmentId === 'broken')
    expect(ended).toMatchObject({ outcome: 'failed', reason: expect.stringContaining('run directory is gone') })
  })

  it('refuses to deliver to finished work and does not start queued work early', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('x'))
    await store.append('g', assign('y', { after: ['x'] }))
    await store.append('g', assign('z'))
    await store.append('g', { type: 'closed', goalId: 'g', assignmentId: 'z', actor: 'lead', summary: 'ok' })
    await sup.tick()
    await expect(sup.deliver('g', 'z', 'ещё')).rejects.toThrow(/done/)
    expect(await sup.deliver('g', 'y', 'учти это')).toBe('recorded')
    expect(fake.runs.map((r) => r.agent).length).toBe(1)
  })

  it('records a run that has just ended once when two ticks overlap', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ hold: true, final: '<crewboard-report>Готово</crewboard-report>' })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    fake.finish('run-1')
    await Promise.all([sup.tick(), sup.tick()])
    expect(await typesOf(store, 'a')).toEqual(['assigned', 'run_started', 'reported', 'run_ended'])
  })

  it('picks a live run back up after a restart without starting it twice', async () => {
    const fake = createFakeBackend()
    fake.setFallback({ hold: true, final: '<crewboard-report>Готово</crewboard-report>' })
    const first = await setup(fake)
    await goal(first.store)
    await first.store.append('g', assign('a'))
    await first.sup.tick()
    const second = await setup(fake, first.root)
    fake.finish('run-1')
    await second.sup.tick()
    expect(fake.runs.length).toBe(1)
    expect(await typesOf(second.store, 'a')).toEqual(['assigned', 'run_started', 'reported', 'run_ended'])
  })

  it('answers a finished run by starting a new run in the same copy with the context', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-question>Шторка?</crewboard-question>' }, { final: '<crewboard-report>ok</crewboard-report>' })
    await goal(store)
    await store.append('g', assign('a', { resultKind: 'branch' }))
    await sup.tick()
    await sup.tick()
    await sup.deliver('g', 'a', 'Ответ: шторка снизу')
    expect(fake.runs.length).toBe(2)
    expect(fake.runs[1]!.cwd).toBe(fake.runs[0]!.cwd)
    expect(fake.runs[1]!.prompt).toContain('Шторка?')
    expect(fake.runs[1]!.prompt).toContain('шторка снизу')
  })

  it('resumes the same agent after an answer but not after handoff', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: '<crewboard-question>Question?</crewboard-question>', usage: { sessionId: 'session-1', calls: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 } }, { hold: true })
    await goal(store)
    await store.append('g', assign('a'))
    await sup.tick()
    await sup.tick()
    // A clarification recorded while no run was open reaches the resumed session too.
    await store.append('g', { type: 'steered', goalId: 'g', assignmentId: 'a', actor: 'lead', text: 'keep the old API' })
    await sup.deliver('g', 'a', 'answer')
    expect(fake.launches[1]).toMatchObject({ previousSessionId: 'session-1' })
    expect(fake.runs[1]!.prompt).toContain('keep the old API')
    await sup.reassign('g', 'a', 'codex')
    expect(fake.launches[2]).not.toHaveProperty('previousSessionId')
  })

  it('cancels a subtree and stops its live runs', async () => {
    const { store, sup, fake } = await setup()
    fake.setFallback({ hold: true })
    await goal(store)
    await store.append('g', assign('box'))
    await store.append('g', assign('geo', { parentId: 'box' }))
    await sup.tick()
    await sup.cancelTree('g', 'box', 'курс изменён')
    expect(fake.cancelled.length).toBe(2)
    expect((await store.read('g')).filter((e) => e.type === 'run_ended').map((e) => e.type === 'run_ended' && e.outcome)).toEqual(['cancelled', 'cancelled'])
    expect(await statusOf(store, 'box')).toBe('cancelled')
    expect(await statusOf(store, 'geo')).toBe('cancelled')
  })

  it('records what a run cost when it ends, and nothing when the backend knows nothing', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: 'ok', usage: { calls: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, reasoningTokens: 0, usd: 0.04 } }, { final: 'ok' })
    await goal(store)
    await store.append('g', assign('a'))
    await store.append('g', assign('b'))
    await sup.tick()
    await sup.tick()
    const ended = (await store.read('g')).filter((e) => e.type === 'run_ended')
    expect(ended.find((e) => e.assignmentId === 'a')).toMatchObject({ usage: { inputTokens: 1200, outputTokens: 300, usd: 0.04 } })
    expect(ended.find((e) => e.assignmentId === 'b')).not.toHaveProperty('usage')
  })

  it('estimates Codex runs at API prices when the subscription reports no money', async () => {
    const { store, sup, fake } = await setup()
    fake.script({ final: 'ok', usage: { calls: 2, inputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 0, reasoningTokens: 0 } })
    await goal(store)
    await store.append('g', assign('a', { provider: 'codex', model: 'gpt-6-luna' }))
    await sup.tick()
    await sup.tick()
    const ended = (await store.read('g')).find((e) => e.type === 'run_ended')
    expect(ended).toMatchObject({ usage: { inputTokens: 100_000, outputTokens: 20_000, apiUsd: expect.any(Number) } })
  })
})
