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
  prompt(question: string): Promise<string>
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

/** Acceptance-type actions belong to a human: agents run without a TTY and are refused. */
export async function confirmHuman(io: Io, question: string): Promise<boolean> {
  if (!io.isTTY) throw new UserError(cliT(io.lang ?? 'en', 'io.humanOnly'))
  return YES.has((await io.prompt(`${question} [y/N] `)).trim().toLowerCase())
}
