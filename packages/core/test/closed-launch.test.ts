import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RunBackend } from '../src/backend/types.js'
import { nodeExec } from '../src/exec.js'
import type { Backends } from '../src/orchestration/backends.js'
import { launchTask } from '../src/orchestration/launch.js'
import { continueTask, relaunchTask } from '../src/orchestration/relaunch.js'
import { acceptTask, supersedeTask } from '../src/orchestration/review.js'
import { newTask } from '../src/plan/schema.js'
import { CREWBOARD_DIR, initPlan, updatePlan } from '../src/plan/store.js'
import { makeRepo } from './git-helpers.js'

const NOW = new Date('2026-09-24T12:00:00Z')

// rp1: `run rel1` on a task accepted with a negative verdict started a new worker in its old copy.
async function setup() {
  const root = await makeRepo()
  await writeFile(join(root, 'contract.md'), '# Contract\nDo the thing.\n')
  await initPlan(root, 'g', NOW)
  const finished = { runId: 'run_dsh-a', agent: 'dsh', startedAt: '2026-09-24T11:00:00Z', finishedAt: '2026-09-24T11:10:00Z', outcome: 'incomplete' as const }
  await updatePlan(root, (p) => {
    for (const id of ['ok', 'neg', 'sup', 'alt']) p.tasks.push({ ...newTask({ id, title: id, contract: 'contract.md' }), status: 'in_review', runs: [{ ...finished, runId: `run_dsh-${id}` }] })
    return p
  })
  await acceptTask(root, 'ok', NOW)
  await acceptTask(root, 'neg', NOW, { kind: 'negative', why: 'negative', claim: 'negative', facts: [] })
  await supersedeTask(root, 'sup', 'alt', NOW)
  const launched: string[] = []
  const backend: RunBackend = {
    id: 'dsh',
    launch: async () => {
      launched.push('run')
      return 'run_dsh-new'
    },
    events: async () => [],
    status: async () => ({ status: 'completed', terminal: true, exitCode: 0 }),
    steer: async () => {},
    cancel: async () => {},
  }
  const backends: Backends = { forAgent: async () => backend }
  const base = { root, backends, exec: nodeExec, env: {}, home: root, now: () => NOW, skipPreflight: true }
  return { root, base, launched }
}

const CLOSED = [
  { id: 'ok', code: 'accepted', en: /ok is accepted/, ru: /ok уже принята/ },
  { id: 'neg', code: 'accepted', en: /neg is accepted/, ru: /neg уже принята/ },
  { id: 'sup', code: 'superseded', en: /sup was superseded/, ru: /sup вытеснена/ },
] as const

describe('a closed task starts no worker (rp1)', () => {
  it.each(CLOSED)('run, relaunch and continue refuse $id with a reason in both languages', async ({ id, code, en, ru }) => {
    const { root, base, launched } = await setup()
    await expect(launchTask({ ...base, taskId: id, agent: 'dsh', caller: 'person' })).rejects.toMatchObject({ code, message: expect.stringMatching(en) })
    await expect(launchTask({ ...base, taskId: id, lang: 'ru' })).rejects.toMatchObject({ code, message: expect.stringMatching(ru) })
    await expect(relaunchTask({ ...base, taskId: id, note: 'again' })).rejects.toMatchObject({ code })
    await expect(continueTask({ ...base, taskId: id })).rejects.toMatchObject({ code })
    expect(launched).toEqual([])
    // Refused before anything is written for the new run.
    await expect(readdir(join(root, CREWBOARD_DIR, 'relaunch'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
