import { mkdtemp, readFile, readdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { newTask } from '../src/plan/schema.js'
import { PlanCorruptError, PlanIncompatibleError, QUARANTINE_CAP, initPlan, loadPlan, planPath, savePlan, updatePlan } from '../src/plan/store.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orch-compat-'))
})

const copies = async () => (await readdir(join(root, '.orchestration'))).filter((name) => name.startsWith('plan.json.corrupt-'))

/** A plan as this build writes it, as raw JSON to tamper with. */
async function storedPlan(): Promise<Record<string, any>> {
  const plan = await initPlan(root, 'g')
  await savePlan(root, { ...plan, tasks: [newTask({ id: 'a', title: 'A' })] }, 0)
  return JSON.parse(await readFile(planPath(root), 'utf8'))
}

const write = (value: unknown) => writeFile(planPath(root), JSON.stringify(value))

describe('reading a plan this build cannot read (pq1)', () => {
  it('reads the same schema-invalid plan 100 times and writes at most one quarantine copy', async () => {
    const raw = await storedPlan()
    await write({ ...raw, tasks: [{ ...raw.tasks[0], title: 42 }] })
    for (let i = 0; i < 100; i++) await expect(loadPlan(root)).rejects.toBeInstanceOf(PlanCorruptError)
    expect(await copies()).toHaveLength(1)
  })

  it('quarantines truly broken JSON once, and a second distinct content once more', async () => {
    await initPlan(root, 'g')
    await writeFile(planPath(root), '{ not json')
    const first = await loadPlan(root).catch((e: unknown) => e)
    await loadPlan(root).catch(() => undefined)
    expect(first).toMatchObject({ name: 'PlanCorruptError', code: 'plan_corrupt' })
    expect(await readFile((first as PlanCorruptError).quarantinedTo, 'utf8')).toBe('{ not json')
    expect(await copies()).toHaveLength(1)
    await writeFile(planPath(root), '{ still not json')
    await loadPlan(root).catch(() => undefined)
    expect(await copies()).toHaveLength(2)
  })

  it('keeps at most QUARANTINE_CAP copies per plan, removing the oldest (legacy copies included)', async () => {
    await initPlan(root, 'g')
    const dir = join(root, '.orchestration')
    // Copies the flooding build left behind: one per read, named by the clock.
    for (let i = 0; i < 20; i++) {
      const legacy = join(dir, `plan.json.corrupt-${1_700_000_000_000 + i}`)
      await writeFile(legacy, 'old')
      await utimes(legacy, new Date(1_700_000_000_000 + i * 1000), new Date(1_700_000_000_000 + i * 1000))
    }
    for (let i = 0; i < QUARANTINE_CAP + 3; i++) {
      await writeFile(planPath(root), `{ broken ${i}`)
      await loadPlan(root).catch(() => undefined)
    }
    const left = await copies()
    expect(left).toHaveLength(QUARANTINE_CAP)
    expect(left.some((name) => /corrupt-\d{13}$/.test(name))).toBe(false)
    // The newest content survives.
    const contents = await Promise.all(left.map((name) => readFile(join(dir, name), 'utf8')))
    expect(contents).toContain(`{ broken ${QUARANTINE_CAP + 2}`)
  })

  it('names a plan from a newer format as incompatible, in both languages, without a copy', async () => {
    const raw = await storedPlan()
    await write({ ...raw, version: 2 })
    const err = await loadPlan(root).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlanIncompatibleError)
    expect(err).toMatchObject({ code: 'plan_incompatible', mode: 'read' })
    expect((err as Error).message).toMatch(/update Crewboard/i)
    expect((err as Error).message).toMatch(/обновите Crewboard/i)
    expect(await copies()).toEqual([])
  })

  it('names an unknown value in a closed field the plan cannot be read without as incompatible, without a copy', async () => {
    const raw = await storedPlan()
    await write({ ...raw, tasks: [{ ...raw.tasks[0], status: 'parked' }] })
    for (let i = 0; i < 10; i++) await expect(loadPlan(root)).rejects.toMatchObject({ code: 'plan_incompatible', mode: 'read' })
    expect(await copies()).toEqual([])
  })

  // w1f: `dropped` joined the strict status set. This build reads and rewrites it with its note; a build before
  // it meets an unknown status — the case above — and refuses the plan instead of scheduling a closed task.
  it('reads and keeps a dropped task and its note', async () => {
    const raw = await storedPlan()
    const note = { at: '2026-09-24T00:00:00Z', type: 'comment', text: 'closed as not needed: done by hand', event: { kind: 'dropped', reason: 'done by hand' } }
    await write({ ...raw, tasks: [{ ...raw.tasks[0], status: 'dropped', notes: [note] }] })
    await updatePlan(root, (plan) => plan)
    expect((await loadPlan(root)).tasks[0]).toMatchObject({ status: 'dropped', notes: [{ event: { kind: 'dropped', reason: 'done by hand' } }] })
  })

  it('reads unknown newer values of tolerated fields, keeps unknown keys, and refuses to write instead of dropping them', async () => {
    const raw = await storedPlan()
    const run = { runId: 'run_1', agent: 'codex', startedAt: '2026-09-24T00:00:00Z', workerChoice: 'orchestrator', futureField: { a: 1 } }
    const note = { at: '2026-09-24T00:00:00Z', type: 'handoff', text: 'handed over', event: { kind: 'handed_over', to: 'x' } }
    await write({ ...raw, tasks: [{ ...raw.tasks[0], class: 'ops', runs: [run], notes: [note], check: { state: 'queued', at: '2026-09-24T00:00:00Z' } }] })

    const plan = await loadPlan(root)
    const task = plan.tasks[0]
    expect(task?.class).toBeUndefined()
    expect(task?.check).toBeUndefined()
    expect(task?.runs[0]?.workerChoice).toBeUndefined()
    expect(task?.notes[0]).toMatchObject({ type: 'comment', text: 'handed over' })
    expect(task?.notes[0]?.event).toBeUndefined()
    expect(await copies()).toEqual([])

    const before = await readFile(planPath(root), 'utf8')
    const err = await updatePlan(root, (p) => ({ ...p, goal: 'changed' })).catch((e: unknown) => e)
    expect(err).toMatchObject({ name: 'PlanIncompatibleError', code: 'plan_incompatible', mode: 'write' })
    expect((err as Error).message).toContain('run.workerChoice')
    expect(await readFile(planPath(root), 'utf8')).toBe(before)
  })

  it('writes back unknown keys a newer build added when every value is known', async () => {
    const raw = await storedPlan()
    await write({ ...raw, futurePlanKey: 'p', tasks: [{ ...raw.tasks[0], futureTaskKey: [1, 2] }] })
    await updatePlan(root, (p) => ({ ...p, goal: 'changed' }))
    const saved = JSON.parse(await readFile(planPath(root), 'utf8'))
    expect(saved).toMatchObject({ goal: 'changed', futurePlanKey: 'p', tasks: [{ id: 'a', futureTaskKey: [1, 2] }] })
  })
})
