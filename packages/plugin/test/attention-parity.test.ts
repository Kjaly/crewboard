import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { type Backends, updatePlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../../cli/src/cli.js'
import { makeHarness } from '../../cli/test/harness.js'
import { OrchestraService } from '../src/host/service.js'
import { orchestraTools } from '../src/host/tools.js'

const AT = '2026-09-24T09:00:00Z'
const NOW = new Date('2026-09-24T10:00:00Z')

// B11 (ux2 F4): the tool returned `[]` while `crewboard attention` showed a review and a decision.
it('orchestra_attention returns the same Needs-you list as `crewboard attention --json`', async () => {
  const root = await makeRepo()
  const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: await mkdtemp(join(tmpdir(), 'orch-home-')) }
  const h = makeHarness({ cwd: root, env, now: NOW })
  expect(await run(['init', '--goal', 'Parity'], h.io)).toBe(0)
  for (const id of ['t1', 't2']) expect(await run(['task', 'add', id, '--title', `Task ${id}`], h.io)).toBe(0)
  expect(await run(['task', 'add', 'd1', '--title', 'Pick a name', '--kind', 'decision'], h.io)).toBe(0)
  await updatePlan(root, (p) => {
    for (const task of p.tasks) {
      if (task.kind === 'decision') continue
      task.status = 'in_review'
      if (task.id === 't1') task.check = { state: 'checked', at: AT, note: 'gates green' }
    }
    return p
  })
  h.reset()
  expect(await run(['attention', '--json'], h.io)).toBe(0)
  const cli: unknown = JSON.parse(h.out())
  expect(cli).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'review', taskId: 't1' }), expect.objectContaining({ kind: 'decision', taskId: 'd1' })]))

  const backends: Backends = { forAgent: async () => Promise.reject(new Error('none')) }
  const service = new OrchestraService({ config: { repos: [root], refreshMs: 60_000 }, backendsFor: () => backends, now: () => NOW })
  const tools = orchestraTools({ service, repos: [root], backendsFor: () => backends, env, home: env.HOME as string, now: () => NOW })
  const tool = tools.find((t) => t.name === 'orchestra_attention')!
  expect(await tool.execute({})).toEqual(cli)
})
