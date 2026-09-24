import { cliT } from '../i18n.js'
import { parseArgs } from 'node:util'
import { type Exec, type Lane, type Trajectory, buildTrajectory, loadPlan } from '@crewboard/core'
import { makeBackends, repoRoot } from '../context.js'
import { type Io, UserError } from '../io.js'

const LANES: { lane: Lane; title: string }[] = [
  { lane: 'input', title: 'trace.input' },
  { lane: 'model', title: 'trace.model' },
  { lane: 'tools', title: 'trace.tools' },
  { lane: 'problem', title: 'trace.problem' },
]
const ICON: Record<Lane, string> = { input: '↳', model: '·', tools: '▶', problem: '⚠' }

const sec = (ms: number, lang: 'en' | 'ru') => `${(ms / 1000).toFixed(1)} ${cliT(lang, 'trace.sec')}`
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10
  const m100 = n % 100
  if (m10 === 1 && m100 !== 11) return one
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few
  return many
}

function bar(t: Trajectory, lane: Lane, width: number): string {
  const cells = Array.from({ length: width }, () => ' ')
  const total = Math.max(1, t.end - t.start)
  for (const s of t.spans.filter((x) => x.lane === lane)) {
    const from = Math.min(width - 1, Math.floor(((s.start - t.start) / total) * width))
    const to = Math.max(from + 1, Math.min(width, Math.ceil(((s.end - t.start) / total) * width)))
    for (let i = from; i < to; i++) cells[i] = s.approximate ? '▒' : '█'
  }
  return cells.join('')
}

export function renderTrace(t: Trajectory, width = 60, lang: 'en' | 'ru' = 'en'): string {
  const x = t.totals
  const head = [
    `${x.turns} ${lang === 'en' ? cliT(lang, x.turns === 1 ? 'trace.turn' : 'trace.turnsMany') : plural(x.turns, cliT(lang, 'trace.turn'), cliT(lang, 'trace.turnsFew'), cliT(lang, 'trace.turnsMany'))}`,
    `${x.toolCalls} ${lang === 'en' ? cliT(lang, x.toolCalls === 1 ? 'trace.tool' : 'trace.toolsMany') : plural(x.toolCalls, cliT(lang, 'trace.tool'), cliT(lang, 'trace.toolsFew'), cliT(lang, 'trace.toolsMany'))}`,
    `${cliT(lang, 'trace.model')} ${sec(x.modelMs, lang)}`,
    `${cliT(lang, 'trace.tools')} ${sec(x.toolMs, lang)}`,
    `${cliT(lang, 'trace.total')} ${sec(x.durationMs, lang)}`,
  ]
  if (x.contextPeak) head.push(`${cliT(lang, 'trace.context')} ${(x.contextPeak.used / 1000).toFixed(1)}k/${Math.round(x.contextPeak.size / 1000)}k`)
  const lines = [head.join(' · '), '']
  for (const { lane, title } of LANES) lines.push(`${cliT(lang, title).padEnd(11)}|${bar(t, lane, width)}|`)
  lines.push('')
  for (const turn of t.turns) {
    lines.push(`${cliT(lang, 'trace.turn')} ${turn.index}  ${clock(turn.start - t.start)}–${clock(turn.end - t.start)}  ${turn.stopReason ?? '…'}${turn.prompt ? `  «${turn.prompt.slice(0, 60)}»` : ''}`)
    // A turn owns spans up to its end; the boundary belongs to the next turn. The last turn has no
    // next one, so it also owns spans that land exactly on its end (instant runs collapse there).
    const last = turn === t.turns.at(-1)
    for (const s of t.spans) {
      if (s.lane === 'model' || s.start < turn.start || (!last && s.start >= turn.end)) continue
      const dur = s.end > s.start ? `  ${sec(s.end - s.start, lang)}${s.approximate ? ' ≈' : ''}` : ''
      lines.push(`  +${clock(s.start - t.start)}  ${ICON[s.lane]} ${s.label}${dur}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function cmdTrace(argv: string[], io: Io, exec: Exec): Promise<number> {
  const [id, ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' }, plan: { type: 'string' } } })
  if (!id) throw new UserError(cliT(io.lang ?? 'en', 'trace.usage'), 2)
  const root = await repoRoot(io, exec)
  const task = (await loadPlan(root, values.plan)).tasks.find((t) => t.id === id)
  if (!task) throw new UserError(cliT(io.lang ?? 'en', 'trace.noTask', { id }))
  const run = task.runs.at(-1)
  if (!run) throw new UserError(cliT(io.lang ?? 'en', 'trace.noRuns', { id }))
  const backend = await makeBackends(io, exec, root).forAgent(run.agent, run.runId)
  const trajectory = buildTrajectory(await backend.events(run.runId), { startedAt: run.startedAt, finishedAt: run.finishedAt }, io.now())
  io.out(values.json ? `${JSON.stringify(trajectory, null, 2)}\n` : renderTrace(trajectory, 60, io.lang ?? 'en'))
  return 0
}
