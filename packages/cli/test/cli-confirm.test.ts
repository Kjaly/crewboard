import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { loadPlan } from '@crewboard/core'
import { makeRepo } from '../../core/test/git-helpers.js'
import { run } from '../src/cli.js'
import { askLine } from '../src/io.js'
import { makeHarness } from './harness.js'

/** A terminal-like prompt over streams the test controls: the same `askLine` the real CLI uses. */
function streamPrompt(onQuestion: (input: PassThrough) => void) {
  return (question: string) => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.once('data', () => onQuestion(input))
    return askLine(question, { input, output })
  }
}

describe('askLine', () => {
  const ask = (write: (input: PassThrough) => void, terminal = false) => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()
    const answer = askLine('Sure? ', { input, output, terminal })
    write(input)
    return answer
  }

  it('returns the typed line, and undefined for end of input, Ctrl+D and Ctrl+C', async () => {
    expect(await ask((i) => i.write('y\n'))).toBe('y')
    expect(await ask((i) => i.end())).toBeUndefined()
    expect(await ask((i) => i.write('\x04'), true)).toBeUndefined()
    expect(await ask((i) => i.write('\x03'), true)).toBeUndefined()
  })
})

describe('a confirmation closed with Ctrl+D (rp1)', () => {
  async function setup() {
    const root = await makeRepo()
    const bot = makeHarness({ cwd: root })
    await run(['init'], bot.io)
    await run(['task', 'add', 'a', '--title', 'A'], bot.io)
    return root
  }

  it('means no: the cancelled line, exit 1 and no stack, like answering «n»', async () => {
    const root = await setup()
    const closed = makeHarness({ cwd: root, isTTY: true })
    closed.io.prompt = streamPrompt((input) => input.end())
    expect(await run(['reject', 'a', '--reason', 'r'], closed.io)).toBe(1)
    expect(closed.out()).toBe('\nCancelled.\n')
    expect(closed.err()).toBe('')

    const no = makeHarness({ cwd: root, isTTY: true, answers: ['n'] })
    expect(await run(['reject', 'a', '--reason', 'r'], no.io)).toBe(1)
    expect(no.out()).toBe('Cancelled.\n')
    expect((await loadPlan(root)).tasks.find((t) => t.id === 'a')?.status).toBe('ready')
  })

  it('prints no AbortError at any confirmation, in both languages', async () => {
    const root = await setup()
    for (const argv of [['accept', 'a'], ['supersede', 'a', '--by', 'a'], ['--lang', 'ru', 'reject', 'a', '--reason', 'r']]) {
      const h = makeHarness({ cwd: root, isTTY: true })
      h.io.prompt = streamPrompt((input) => input.end())
      expect(await run(argv, h.io)).toBe(1)
      expect(h.out()).toMatch(argv[0] === '--lang' ? /\nОтменено\.\n$/ : /\nCancelled\.\n$/)
      expect(h.out() + h.err()).not.toMatch(/AbortError|\n\s+at /)
    }
  })
})
