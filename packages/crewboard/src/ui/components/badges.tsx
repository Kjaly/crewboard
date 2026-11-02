import { CheckCircle, Clock, HandWaving, Pause, Prohibit, Question } from '../icons.js'
import type { AssignmentView, Status } from '../../model/types.js'
import { T } from '../text.js'

const LETTER: Record<AssignmentView['provider'], string> = { claude: 'C', codex: 'X', deepseek: 'D', lead: 'C' }
const CLASS: Record<AssignmentView['provider'], string> = { claude: 'claude', codex: 'codex', deepseek: 'deepseek', lead: 'claude' }

export function Avatar(props: { provider: AssignmentView['provider'] }) {
  return (
    <span className={`av ${CLASS[props.provider]}`} title={T.provider[props.provider]} aria-hidden="true">
      {LETTER[props.provider]}
    </span>
  )
}

const ICON: Partial<Record<Status, typeof Clock>> = { waiting_owner: HandWaving, waiting_answer: Question, done: CheckCircle, cancelled: Prohibit, abandoned: Prohibit, queued: Clock, paused: Pause }
const TONE: Record<Status, string> = { running: 'running', waiting_owner: 'ask', waiting_answer: 'running', done: 'done', cancelled: 'cancel', abandoned: 'cancel', queued: 'queued', paused: 'queued' }

export function StatusBadge(props: { status: Status }) {
  const Icon = ICON[props.status]
  return (
    <span className={`st ${TONE[props.status]}`}>
      {props.status === 'running' ? <span className="live" aria-hidden="true" /> : Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {T.status[props.status]}
    </span>
  )
}
