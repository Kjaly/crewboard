import { createInterface } from 'node:readline'
import { cliT } from './i18n.js'

export type Io = {
  lang?: 'ru' | 'en'
  /** The command name the person typed; usage lines repeat it. Omitted: `crewboard`. */
  program?: string
  cwd: string
  env: NodeJS.ProcessEnv
  out(s: string): void
  err(s: string): void
  isTTY: boolean
  /** The typed line; `undefined` when input ended (Ctrl+D) or was interrupted (Ctrl+C) before an answer. */
  prompt(question: string): Promise<string | undefined>
  now(): Date
}

/** An expected, user-facing failure: printed without a stack, exit code 1 (or `code`). */
export class UserError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message)
    this.name = 'UserError'
  }
}

const YES = new Set(['y', 'yes', 'д', 'да'])

/**
 * One question on a terminal. Ctrl+D (end of input) and Ctrl+C resolve `undefined` instead of rejecting:
 * the promise API of readline turns them into an `AbortError` that reached the person as a stack (rp1).
 */
export function askLine(question: string, streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; terminal?: boolean }): Promise<string | undefined> {
  const rl = createInterface(streams)
  return new Promise((resolve) => {
    rl.on('SIGINT', () => rl.close())
    rl.on('close', () => resolve(undefined))
    rl.question(question, (answer) => {
      resolve(answer)
      rl.close()
    })
  })
}

/**
 * Acceptance-type actions belong to a human: agents run without a TTY and are refused. Anything but a yes —
 * «n», an empty line, Ctrl+D, Ctrl+C — is a no and prints the same cancelled line; the caller exits 1.
 */
export async function confirmHuman(io: Io, question: string): Promise<boolean> {
  const lang = io.lang ?? 'en'
  if (!io.isTTY) throw new UserError(cliT(lang, 'io.humanOnly'))
  const answer = await io.prompt(`${question} [y/N] `)
  if (answer !== undefined && YES.has(answer.trim().toLowerCase())) return true
  // Ctrl+D leaves the cursor after the question: the cancelled line starts on its own line.
  io.out(`${answer === undefined ? '\n' : ''}${cliT(lang, 'plan.cancelled')}\n`)
  return false
}
