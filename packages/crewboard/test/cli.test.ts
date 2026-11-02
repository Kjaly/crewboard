import { describe, expect, it } from 'vitest'
import { portOf } from '../src/cli.js'

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
