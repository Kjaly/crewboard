import { describe, expect, it } from 'vitest'
import type { Exec } from '@crewboard/core'
import { macNative } from '../src/host/native.js'

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })

describe('macNative', () => {
  it('passes user text as osascript arguments, never inside the script', async () => {
    const calls: string[][] = []
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args])
      return ok('Принять\n')
    }
    const n = macNative(exec, 'darwin')
    const hostile = 'x" & (do shell script "rm -rf ~") & "'
    expect(await n.confirm('crewboard', hostile, 'Принять')).toBe(true)
    const [cmd, ...args] = calls[0] as string[]
    expect(cmd).toBe('osascript')
    expect(args.slice(-4)).toEqual(['crewboard', hostile, 'Принять', 'Cancel'])
    const script = args.filter((_, i) => args[i - 1] === '-e').join('\n')
    expect(script).not.toContain('shell script')
    expect(script).toContain('on run argv')
    await n.notify('t', 'm')
    expect(calls[1]?.slice(-2)).toEqual(['t', 'm'])
  })

  it('declines on cancel, on timeout and off macOS', async () => {
    const cancel: Exec = async () => ({ code: 1, stdout: '', stderr: 'User canceled. (-128)', timedOut: false })
    expect(await macNative(cancel, 'darwin').confirm('t', 'm', 'Принять')).toBe(false)
    const gaveUp: Exec = async () => ok('\n')
    expect(await macNative(gaveUp, 'darwin').confirm('t', 'm', 'Принять')).toBe(false)
    let called = false
    const never: Exec = async () => {
      called = true
      return ok('Принять')
    }
    expect(await macNative(never, 'linux').confirm('t', 'm', 'Принять')).toBe(false)
    await macNative(never, 'linux').notify('t', 'm')
    expect(called).toBe(false)
  })
})
