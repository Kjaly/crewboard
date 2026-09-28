import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { guardEpipe } from '../src/epipe.js'

// cl2: `crewboard status | head` breaks the pipe once `head` exits; the guard must exit quietly instead
// of letting the stream's unhandled `error` event crash the process with a stack. Exercised against a
// plain EventEmitter — the real wiring in main.ts (`guardEpipe(process.stdout, ...)`) is a one-liner.
describe('guardEpipe', () => {
  it('exits quietly on EPIPE', () => {
    const stream = new EventEmitter()
    const exit = vi.fn()
    guardEpipe(stream, exit)
    stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('rethrows any other stream error instead of swallowing it', () => {
    const stream = new EventEmitter()
    guardEpipe(stream, () => {})
    expect(() => stream.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' }))).toThrow('boom')
  })
})
