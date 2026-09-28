import { parseArgs } from 'node:util'
import { type Exec, answerDecision, callerOf, prepareDecision } from '@crewboard/core'
import { makeBackends, repoRoot } from '../context.js'
import { cliT } from '../i18n.js'
import { type Io, UserError } from '../io.js'
import { syncPlan } from './runs.js'

/**
 * `decision answer|prepare` (dc1): the agent path for what the person already said in chat — no terminal
 * confirmation, because nothing new is being asked of them. `answer` records the answer they gave (with
 * the basis it rests on) and closes the decision; `prepare` sends an open decision back into the
 * orchestrator's preparation on their «investigate and propose».
 */
export async function cmdDecision(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [sub, id, ...rest] = argv
  const lang = io.lang ?? 'en'
  const { values } = parseArgs({
    args: rest,
    options: { answer: { type: 'string' }, basis: { type: 'string' }, reason: { type: 'string' }, plan: { type: 'string' } },
  })
  if ((sub !== 'answer' && sub !== 'prepare') || !id) throw new UserError(cliT(lang, 'decision.usage'), 2)
  if (sub === 'answer' && (!values.answer?.trim() || !values.basis?.trim())) throw new UserError(cliT(lang, 'decision.usage'), 2)
  if (sub === 'prepare' && !values.reason?.trim()) throw new UserError(cliT(lang, 'decision.usage'), 2)
  const root = await repoRoot(io, exec)
  // A run that already ended but was not synced yet must not read as «running».
  await syncPlan(root, io, makeBackends(io, exec, root), values.plan)
  if (sub === 'answer') {
    const { repeated } = await answerDecision(root, id, values.answer as string, values.basis as string, io.now(), { planId: values.plan, lang })
    io.out(cliT(lang, repeated ? 'decision.answerRepeated' : 'decision.answered', { id, answer: (values.answer as string).trim() }))
    return 0
  }
  const by = callerOf({ kind: 'cli', isTTY: io.isTTY }) === 'person' ? 'person' : 'orchestrator'
  await prepareDecision(root, id, values.reason as string, io.now(), { planId: values.plan, lang, by })
  io.out(cliT(lang, 'decision.prepared', { id }))
  return 0
}
