import type { Io } from '../src/io.js'

export function makeHarness(opts: { cwd: string; env?: NodeJS.ProcessEnv; isTTY?: boolean; answers?: string[]; now?: Date }) {
  let out = ''
  let err = ''
  const answers = [...(opts.answers ?? [])]
  const questions: string[] = []
  let now = opts.now ?? new Date('2026-09-22T11:00:00Z')
  const io: Io = {
    cwd: opts.cwd,
    env: opts.env ?? { ...process.env },
    out: (s) => {
      out += s
    },
    err: (s) => {
      err += s
    },
    isTTY: opts.isTTY ?? false,
    prompt: async (question: string) => {
      questions.push(question)
      return answers.shift() ?? ''
    },
    now: () => now,
  }
  return {
    io,
    out: () => out,
    err: () => err,
    /** Every question a confirmation asked, in order. */
    questions: () => questions,
    reset: () => {
      out = ''
      err = ''
    },
    setNow: (d: Date) => {
      now = d
    },
  }
}
