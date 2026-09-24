import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createDshBackend } from '../src/dsh/backend.js'
import { createCliBackend } from '../src/runs/cli-backend.js'

// A launch whose supervisor never starts (e.g. its entry file is missing) must not stay "starting" forever.
it('reports a run whose supervisor never wrote its state as failed after the start timeout', async () => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'orch-guard-'))
  const backends = [createCliBackend({ kind: 'codex', runsRoot }), createDshBackend({ runsRoot })]
  for (const [i, backend] of backends.entries()) {
    const fresh = `run_x-fresh${i}`
    const stale = `run_x-stale${i}`
    for (const id of [fresh, stale]) {
      await mkdir(join(runsRoot, id), { recursive: true })
      await writeFile(join(runsRoot, id, 'args.json'), '{}')
    }
    const old = new Date(Date.now() - 5 * 60_000)
    await utimes(join(runsRoot, stale, 'args.json'), old, old)
    expect(await backend.status(fresh)).toEqual({ status: 'starting', terminal: false, exitCode: null })
    expect(await backend.status(stale)).toEqual({ status: 'failed', terminal: true, exitCode: 1 })
  }
})
