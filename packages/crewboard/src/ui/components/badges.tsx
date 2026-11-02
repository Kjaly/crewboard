import { CheckCircle, Clock, HandWaving, Pause, Prohibit, Question } from '../icons.js'
import type { AssignmentView, Status } from '../../model/types.js'
import { agentOf } from '../agents.js'
import { T, providerLabel } from '../text.js'

const LETTER: Record<string, string> = { claude: 'C', codex: 'X', deepseek: 'D', lead: 'C' }
const CLASS: Record<string, string> = { claude: 'claude', codex: 'codex', deepseek: 'deepseek', lead: 'claude' }

/** An agent's mark: the built-in colours, the registry's colour for others, neutral for an agent no longer registered. */
export function Avatar(props: { provider: AssignmentView['provider'] }) {
  const label = providerLabel(props.provider)
  const color = agentOf(props.provider)?.color
  return (
    <span className={`av ${CLASS[props.provider] ?? 'other'}`} style={color ? { background: color } : undefined} title={label} aria-hidden="true">
      {LETTER[props.provider] ?? label.charAt(0).toUpperCase()}
    </span>
  )
}

const ICON: Partial<Record<Status, typeof Clock>> = { waiting_owner: HandWaving, waiting_answer: Question, reported: CheckCircle, done: CheckCircle, cancelled: Prohibit, abandoned: Prohibit, queued: Clock, paused: Pause }
const TONE: Record<Status, string> = { running: 'running', waiting_owner: 'ask', waiting_answer: 'running', reported: 'running', done: 'done', cancelled: 'cancel', abandoned: 'cancel', queued: 'queued', paused: 'queued' }

export function StatusBadge(props: { status: Status }) {
  const Icon = ICON[props.status]
  return (
    <span className={`st ${TONE[props.status]}`}>
      {props.status === 'running' ? <span className="live" aria-hidden="true" /> : Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {T.status[props.status]}
    </span>
  )
}
