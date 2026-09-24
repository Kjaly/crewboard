import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { launchTask } from '../src/orchestration/launch.js'
import { relaunchTask } from '../src/orchestration/relaunch.js'
import { newTask } from '../src/plan/schema.js'
import { initPlan, loadPlan, planPath, updatePlan } from '../src/plan/store.js'
import { callerOf, markOutsidePreset, runWorkerChoice } from '../src/routing/authority.js'
import { olderConfigPath } from '../src/routing/profile-store.js'
import { resolveRouting, savePreset, setRepositoryPreset } from '../src/routing/presets.js'
import { makeRepo } from './git-helpers.js'

// wp1 (2026-09-24): the preset is the owner's decision. A person may assign any worker; an agent may
// choose only inside the effective preset for the task's class.

const NOW = new Date('2026-09-24T12:00:00Z')
const ONLY_DSH = { id: 'only-dsh', label: 'Only dsh', routing: { code: ['dsh'], design: ['dsh'], review: ['dsh'], research: ['dsh'] } }
const ONLY_FLASH = { id: 'only-flash', label: 'Only flash', routing: { code: ['dsh/deepseek-flash'], design: ['dsh/deepseek-flash'], review: ['dsh/deepseek-flash'], research: ['dsh/deepseek-flash'] } }

async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'c.md'), 'do it\n')
  await initPlan(root, 'g', NOW)
  await updatePlan(root, (p) => {
    p.tasks.push(newTask({ id: 'ui', title: 'UI', contract: 'c.md', class: 'design' }))
    return p
  })
  const home = await mkdtemp(join(tmpdir(), 'orch-authority-'))
  await mkdir(join(olderConfigPath({}, home), '..'), { recursive: true })
  await writeFile(olderConfigPath({}, home), JSON.stringify({ agents: {}, routing: { classes: { design: ['dsh/deepseek-flash', 'dsh'] } } }))
  const env = { HOME: home }
  await savePreset(ONLY_DSH, env)
  await savePreset(ONLY_FLASH, env)
  await setRepositoryPreset(root, 'only-dsh', env)
  const launched: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async ({ agent }) => {
      launched.push(agent)
      return `run_dsh-${launched.length}`
    },
    events: async () => [],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, skipPreflight: true, backends, exec: nodeExec, env: {}, home, now: () => NOW }
  const task = async () => (await loadPlan(root)).tasks.find((t) => t.id === 'ui')!
  return { root, home, env, base, launched, task }
}

describe('callerOf', () => {
  it('a terminal is a person only with an interactive TTY; the screen is a person; a chat tool is an agent', () => {
    expect(callerOf({ kind: 'cli', isTTY: true })).toBe('person')
    expect(callerOf({ kind: 'cli', isTTY: false })).toBe('agent')
    expect(callerOf({ kind: 'ui' })).toBe('person')
    expect(callerOf({ kind: 'tool' })).toBe('agent')
  })
})

describe('worker source migration', () => {
  it('a stored worker becomes an agent assignment unless a note says it was chosen in the UI', async () => {
    const root = await makeRepo()
    await initPlan(root, 'g', NOW)
    const raw = JSON.parse(await readFile(planPath(root), 'utf8'))
    const note = (text: string) => ({ at: NOW.toISOString(), type: 'comment', text })
    raw.tasks = [
      { id: 'a', title: 'A', kind: 'implement', status: 'ready', worker: 'codex/gpt-6-sol', notes: [note('Launched by hand outside the preset “Claude”: codex/gpt-6-sol')] },
      { id: 'b', title: 'B', kind: 'implement', status: 'ready', worker: 'devin', notes: [note('Worker chosen in the UI by the owner')] },
      { id: 'c', title: 'C', kind: 'implement', status: 'ready', worker: 'dsh', notes: [note('Воркер выбран в интерфейсе')] },
      { id: 'd', title: 'D', kind: 'implement', status: 'ready' },
    ]
    await writeFile(planPath(root), JSON.stringify(raw))
    const tasks = (await loadPlan(root)).tasks
    expect(tasks.map((t) => [t.id, t.workerSource])).toEqual([['a', 'agent'], ['b', 'person'], ['c', 'person'], ['d', undefined]])
  })

  it('reads the source of old runs from the old note: an explicit pick counts as an agent\'s', () => {
    const at = NOW.toISOString()
    expect(runWorkerChoice({ startedAt: at }, [{ at, text: 'Launched by hand outside the preset “Claude”: devin' }])).toBe('agent')
    expect(runWorkerChoice({ startedAt: at }, [])).toBe('preset')
    expect(runWorkerChoice({ startedAt: at, workerChoice: 'person' }, [])).toBe('person')
  })
})

describe('launch under the preset authority', () => {
  it('refuses an agent\'s -a outside the preset with the preset, the class and the allowed workers', async () => {
    const { base, launched, task } = await setup()
    await expect(launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', caller: 'agent' })).rejects.toMatchObject({
      code: 'outside_preset',
      message: expect.stringMatching(/Only dsh[\s\S]*design[\s\S]*may choose only: dsh[\s\S]*Ask the person to choose another worker or change the preset/),
    })
    await expect(launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', lang: 'ru' })).rejects.toMatchObject({
      code: 'outside_preset',
      message: expect.stringMatching(/«Only dsh»[\s\S]*может выбрать только: dsh[\s\S]*Попросите человека/),
    })
    expect(launched).toEqual([])
    expect((await task()).worker).toBeUndefined()
  })

  it('lets an agent pick inside the preset and records it as the agent\'s choice', async () => {
    const { base, task } = await setup()
    expect(await launchTask({ ...base, taskId: 'ui', agent: 'dsh', caller: 'agent' })).toMatchObject({ agent: 'dsh' })
    expect(await task()).toMatchObject({ worker: 'dsh', workerSource: 'agent' })
    expect((await task()).runs.at(-1)?.workerChoice).toBe('agent')
  })

  it('runs a person\'s pick outside the preset, marks it hand-picked and notes it', async () => {
    const { root, env, base, task } = await setup()
    expect(await launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', caller: 'person' })).toMatchObject({ agent: 'dsh/deepseek-flash' })
    const t = await task()
    expect(t).toMatchObject({ worker: 'dsh/deepseek-flash', workerSource: 'person' })
    expect(t.runs.at(-1)?.workerChoice).toBe('person')
    expect(t.notes.at(-1)?.text).toMatch(/Only dsh.*dsh\/deepseek-flash/)
    const routing = await resolveRouting(root, undefined, env)
    const [marked] = markOutsidePreset([t], routing)
    expect(marked?.outsidePreset).toBe(true)
    // Accepted, closed or superseded work is history: it does not count as a deviation.
    for (const status of ['accepted', 'closed', 'superseded']) expect(markOutsidePreset([{ ...t, status }], routing)[0]?.outsidePreset).toBeUndefined()
  })

  it('falls back to the preset for an agent\'s assignment the changed preset no longer allows, with a note', async () => {
    const { root, env, base, launched, task } = await setup()
    await setRepositoryPreset(root, 'only-flash', env)
    await launchTask({ ...base, taskId: 'ui', agent: 'dsh/deepseek-flash', caller: 'agent' })
    await updatePlan(root, (p) => { p.tasks.find((t) => t.id === 'ui')!.status = 'ready'; return p })
    await setRepositoryPreset(root, 'only-dsh', env)
    expect(await launchTask({ ...base, taskId: 'ui', caller: 'agent' })).toMatchObject({ agent: 'dsh' })
    expect(launched).toEqual(['dsh/deepseek-flash', 'dsh'])
    const t = await task()
    expect(t.worker).toBeUndefined()
    expect(t.workerSource).toBeUndefined()
    expect(t.runs.at(-1)?.workerChoice).toBe('preset')
    expect(t.notes.at(-1)?.text).toMatch(/dsh\/deepseek-flash, chosen by an agent, is no longer in the preset “Only dsh”.*ran by the preset order instead: dsh/)
  })

  it('keeps running a person\'s assignment after the preset changes', async () => {
    const { root, base, launched } = await setup()
    await updatePlan(root, (p) => { Object.assign(p.tasks.find((t) => t.id === 'ui')!, { worker: 'dsh/deepseek-flash', workerSource: 'person' }); return p })
    expect(await launchTask({ ...base, taskId: 'ui', caller: 'agent' })).toMatchObject({ agent: 'dsh/deepseek-flash' })
    expect(launched).toEqual(['dsh/deepseek-flash'])
  })

  it('-a auto clears the assignment and its source; the preset decides', async () => {
    const { root, base, task } = await setup()
    await updatePlan(root, (p) => { Object.assign(p.tasks.find((t) => t.id === 'ui')!, { worker: 'dsh/deepseek-flash', workerSource: 'person' }); return p })
    expect(await launchTask({ ...base, taskId: 'ui', agent: 'auto', caller: 'agent' })).toMatchObject({ agent: 'dsh' })
    const t = await task()
    expect(t.worker).toBeUndefined()
    expect(t.workerSource).toBeUndefined()
  })

  it('a relaunch keeps the previous worker only while the preset allows it', async () => {
    const { root, env, base, launched } = await setup()
    await launchTask({ ...base, taskId: 'ui' })
    await relaunchTask({ ...base, taskId: 'ui' })
    await setRepositoryPreset(root, 'only-flash', env)
    await relaunchTask({ ...base, taskId: 'ui' })
    expect(launched).toEqual(['dsh', 'dsh', 'dsh/deepseek-flash'])
  })
})
