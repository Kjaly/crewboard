import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFileSync: vi.fn() }))

let guard: typeof import('./process-guard.js')

beforeEach(async () => {
  vi.stubEnv('CREWBOARD_TEST_PROCESS_GUARD_DISABLED', undefined)
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.resetModules()
  vi.mocked(execFileSync).mockReset()
  guard = await import('./process-guard.js')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('process leak guard', () => {
  it('skips scans after ps is denied, warns once, and allows setup and teardown', async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' }) })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const teardown = guard.default()
    expect(guard.findTagged(guard.TAG_ENV, 'test')).toEqual([])
    expect(guard.findTagged(guard.TAG_ENV, 'test')).toEqual([])
    await expect(teardown()).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledTimes(1)
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })

  it('still finds tagged processes when ps works', () => {
    vi.mocked(execFileSync).mockReturnValue('123456 1 node worker CREWBOARD_TEST_TAG=test\n123457 1 node other CREWBOARD_TEST_TAG=other\n')
    expect(guard.findTagged(guard.TAG_ENV, 'test')).toEqual([{ pid: 123456, ppid: 1, command: 'node worker', env: { CREWBOARD_TEST_TAG: 'test' } }])
  })

  it('does not hide unrelated process inspection failures', () => {
    const failure = Object.assign(new Error('ps missing'), { code: 'ENOENT' })
    vi.mocked(execFileSync).mockImplementation(() => { throw failure })
    expect(() => guard.findTagged(guard.TAG_ENV, 'test')).toThrow(failure)
  })
})
