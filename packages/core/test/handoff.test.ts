import { describe, expect, it } from 'vitest'
import { type AgentHandoffTarget, type HandoffTask, agentHandoff } from '../src/orchestration/handoff.js'

const task = (patch: Partial<HandoffTask> = {}): AgentHandoffTarget => ({
  kind: 'task',
  repo: '/work/repo',
  planId: 'main',
  task: { id: 't1', title: 'Fix the parser', status: 'ready', ...patch },
})

describe('agentHandoff', () => {
  it('carries the repository, plan, task, status, wait and commands for a task', () => {
    const text = agentHandoff(task())
    for (const line of ['Repository: /work/repo', 'Plan: main', 'Task: t1 — Fix the parser', 'Status: ready', 'Waiting for the person:', 'Commands:']) {
      expect(text).toContain(line)
    }
    expect(text).toContain('  orch events t1')
    expect(text).toContain('  orch run t1')
  })

  const cases: Array<{ status: HandoffTask['status']; kind?: HandoffTask['kind']; has: string[]; missing: string[] }> = [
    { status: 'ready', has: ['orch run t1'], missing: ['orch accept t1', 'orch steer t1', 'orch stop t1'] },
    { status: 'running', has: ['orch events t1', 'orch steer t1 --message "…"', 'orch stop t1'], missing: ['orch run t1', 'orch accept t1'] },
    { status: 'in_review', has: ['orch events t1', 'orch trace t1 --json'], missing: ['orch run t1', 'orch accept t1', 'orch reject t1'] },
    { status: 'blocked', has: ['orch events t1'], missing: ['orch run t1', 'orch accept t1'] },
    { status: 'accepted', has: ['orch events t1'], missing: ['orch run t1', 'orch accept t1'] },
    { status: 'closed', has: ['orch events t1'], missing: ['orch run t1', 'orch accept t1'] },
    { status: 'superseded', has: ['orch events t1'], missing: ['orch run t1'] },
    { status: 'backlog', has: ['orch task set t1 --status ready'], missing: ['orch run t1', 'orch accept t1'] },
    { status: 'ready', kind: 'decision', has: ['orch events t1', 'orch trace t1 --json'], missing: ['orch run t1', 'orch accept t1', 'orch reject t1'] },
  ]
  for (const { status, kind, has, missing } of cases) {
    it(`offers only commands that fit «${status}${kind ? `/${kind}` : ''}»`, () => {
      const text = agentHandoff(task({ status, ...(kind ? { kind } : {}) }))
      for (const command of has) expect(text).toContain(`  ${command}`)
      for (const command of missing) expect(text).not.toContain(`  ${command}`)
    })
  }

  it('uses the assigned worker profile when launching a ready task', () => {
    const text = agentHandoff(task({ worker: 'dsh/deepseek-flash' }))
    expect(text).toContain('  orch run t1 -a dsh/deepseek-flash')
    expect(text).not.toContain('  orch run t1\n')
  })

  it('summarizes a plan with each waiting task and its commands', () => {
    const text = agentHandoff({
      kind: 'plan',
      repo: '/work/repo',
      planId: 'main',
      goal: 'Ship the parser',
      tasks: [
        { id: 't1', title: 'A', status: 'ready' },
        { id: 't2', title: 'B', status: 'in_review' },
        { id: 't3', title: 'C', status: 'accepted' },
      ],
    })
    expect(text).toContain('Plan: main — Ship the parser')
    expect(text).toContain('Status: t1 ready; t2 in_review; t3 accepted')
    expect(text).toContain('Waiting for the person: t2 — review the result; the person accepts it')
    expect(text).toContain('  orch status')
    expect(text).toContain('  orch run t1')
    expect(text).not.toContain('  orch accept t2')
    expect(text).not.toContain('  orch run t2')
    expect(text).not.toContain('  orch events t3')
  })

  it('adds the finding line for a review finding', () => {
    const text = agentHandoff({
      kind: 'finding',
      repo: '/work/repo',
      planId: 'main',
      task: { id: 't1', title: 'Fix the parser', status: 'in_review' },
      finding: 'checks_not_run — a required check did not run',
    })
    expect(text).toContain('Finding: checks_not_run — a required check did not run')
    expect(text).toContain('  orch trace t1 --json')
  })

  it('localises the headings and the wait sentence in Russian', () => {
    const text = agentHandoff(task({ status: 'in_review' }), 'ru')
    expect(text).toContain('Репозиторий: /work/repo')
    expect(text).toContain('План: main')
    expect(text).toContain('Задача: t1 — Fix the parser')
    expect(text).toContain('Статус: in_review')
    expect(text).toContain('Ждёт человека: проверить результат; принимает или возвращает человек')
    expect(text).toContain('Команды:')
    // Commands and ids stay untranslated.
    expect(text).toContain('  orch events t1')
    expect(text).not.toContain('  orch accept t1')
  })

  it('says nothing waits for a task that is merely running', () => {
    expect(agentHandoff(task({ status: 'running' }))).toContain('Waiting for the person: nothing yet — a worker is running; steer it if it drifts.')
    expect(agentHandoff({ kind: 'plan', repo: '/work/repo', planId: 'main', goal: 'g', tasks: [] })).toContain('Waiting for the person: nothing — no task is waiting.')
  })

  it('opens the commands block inside the repository and addresses the plan explicitly', () => {
    const text = agentHandoff(task({ status: 'running' }))
    const commands = text.slice(text.indexOf('Commands:')).split('\n')
    expect(commands[1]).toBe('  cd "/work/repo"')
    const orch = commands.map((line) => line.trim()).filter((line) => line.startsWith('orch '))
    expect(orch.length).toBeGreaterThan(0)
    for (const line of orch) expect(line).toContain('--plan main')
    // «plan use» would retarget the shared current plan — a pasted brief must never run it.
    expect(text).not.toContain('orch plan use')
  })

  it('keeps commands plan-addressed in a plan brief and still works without a plan id', () => {
    const withPlan = agentHandoff({ kind: 'plan', repo: '/work/repo', planId: 'main', goal: 'g', tasks: [{ id: 't1', title: 'A', status: 'ready' }] })
    expect(withPlan).toContain('  cd "/work/repo"')
    expect(withPlan).toContain('  orch status --plan main')
    expect(withPlan).toContain('  orch run t1 --plan main')
    const without = agentHandoff({ kind: 'task', repo: '/work/repo', task: { id: 't1', title: 'A', status: 'ready' } })
    expect(without).toContain('  cd "/work/repo"')
    expect(without).toContain('  orch run t1')
    expect(without).not.toContain('--plan')
  })
})
