import { describe, expect, it } from 'vitest'
import { nodeExec } from '../src/exec.js'

describe('nodeExec', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await nodeExec('/bin/sh', ['-c', 'echo hi; echo err >&2; exit 3'])
    expect(r).toMatchObject({ code: 3, stdout: 'hi\n', stderr: 'err\n', timedOut: false })
  })

  it('kills the whole process group on timeout', async () => {
    const started = Date.now()
    const r = await nodeExec('/bin/sh', ['-c', 'sleep 5 & sleep 5; wait'], { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('reports a missing binary as code 127', async () => {
    const r = await nodeExec('/definitely/missing/binary', [])
    expect(r.code).toBe(127)
  })

  it('passes cwd, env and stdin', async () => {
    const r = await nodeExec('/bin/sh', ['-c', 'pwd; echo "$CREWBOARD_T"; cat'], {
      cwd: '/tmp',
      env: { ...process.env, CREWBOARD_T: 'x1' },
      input: 'from-stdin',
    })
    expect(r.stdout).toMatch(/tmp\nx1\nfrom-stdin$/)
  })
})
