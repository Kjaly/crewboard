import { describe, expect, it } from 'vitest'
import { WAIT_SLICE_MS, openRequested, openerFor, portOf, waitSlice } from '../src/cli.js'

describe('the --port flag', () => {
  it.each([
    [[], 4700],
    [['--port', '4800'], 4800],
    [['--port', 'abc'], undefined],
    [['--port'], undefined],
    [['--port', '70000'], undefined],
    [['--port=4800'], undefined],
  ] as const)('%j → %s', (args, expected) => {
    expect(portOf([...args], 4700)).toBe(expected)
  })
})

describe('the --open flag', () => {
  it.each([
    [[], false],
    [['--open'], true],
    [['--port', '4800', '--open'], true],
    [['--open=false'], false],
  ] as const)('%j → %s', (args, expected) => {
    expect(openRequested([...args])).toBe(expected)
  })
})

describe('the wait slices', () => {
  it.each([
    [10 * 60_000, WAIT_SLICE_MS],
    [WAIT_SLICE_MS, WAIT_SLICE_MS],
    [WAIT_SLICE_MS - 1, WAIT_SLICE_MS - 1],
    [1, 1],
    [0, 0],
    [-1, 0],
  ] as const)('remaining %i ms → %i ms', (remaining, expected) => {
    expect(waitSlice(remaining)).toBe(expected)
  })

  it('never asks for a response Node fetch would abort before it starts', () => {
    for (let remaining = 0; remaining <= 3 * 60 * 60_000; remaining += 60_000) expect(waitSlice(remaining)).toBeLessThan(300_000)
  })
})

describe('the browser opener', () => {
  const screenUrl = 'http://127.0.0.1:4700/'
  it.each([
    ['darwin', 'open', [screenUrl]],
    ['linux', 'xdg-open', [screenUrl]],
    ['win32', 'cmd', ['/c', 'start', '', screenUrl]],
  ] as const)('%s → %s %j', (platform, command, expected) => {
    expect(openerFor(platform, screenUrl)).toEqual([command, expected])
  })
})
