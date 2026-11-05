import { CheckCircle, Clock, HandWaving, Pause, Prohibit, Question, Warning } from '../icons.js'
import type { AssignmentView, Status } from '../../model/types.js'
import { agentOf } from '../agents.js'
import { leadLogo, logoOf } from '../logos.js'
import { T, providerLabel } from '../text.js'

const LETTER: Record<string, string> = { claude: 'C', codex: 'X', deepseek: 'D', lead: 'C' }
const CLASS: Record<string, string> = { claude: 'claude', codex: 'codex', deepseek: 'deepseek', lead: 'claude' }

/**
 * An agent's mark: its provider logo on a neutral tile, the built-in colours, the registry's colour for others, or
 * neutral for an agent no longer registered. The goal's root is the lead, so its logo follows the lead client.
 */
export function Avatar(props: { provider: AssignmentView['provider']; leadClient?: string }) {
  const label = providerLabel(props.provider)
  const icon = props.provider === 'lead' ? leadLogo(props.leadClient) : agentOf(props.provider)?.icon
  const logo = logoOf(icon)
  if (logo) {
    // biome-ignore lint/security/noDangerouslySetInnerHtml: bundled, reviewed provider logos; no user input reaches this HTML.
    return <span className="av logo" data-icon={icon} title={label} aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} />
  }
  const color = agentOf(props.provider)?.color
  return (
    <span className={`av ${CLASS[props.provider] ?? 'other'}`} style={color ? { background: color } : undefined} title={label} aria-hidden="true">
      {LETTER[props.provider] ?? label.charAt(0).toUpperCase()}
    </span>
  )
}

const ICON: Partial<Record<Status, typeof Clock>> = { waiting_owner: HandWaving, waiting_answer: Question, reported: CheckCircle, done: CheckCircle, cancelled: Prohibit, abandoned: Prohibit, queued: Clock, paused: Pause }
const TONE: Record<Status, string> = { running: 'running', waiting_owner: 'ask', waiting_answer: 'running', reported: 'running', done: 'done', cancelled: 'cancel', abandoned: 'cancel', queued: 'queued', paused: 'queued' }

export function StatusBadge(props: { status: Status; external?: AssignmentView['external'] }) {
  if (props.external?.outcome) {
    const outcome = props.external.outcome
    const Icon = outcome === 'success' ? CheckCircle : Warning
    return (
      <span className={`st ${outcome === 'success' ? 'done' : 'failed'}`}>
        <Icon size={14} aria-hidden="true" />
        {T.external.outcome[outcome]}
      </span>
    )
  }
  if (props.external?.stale) return (
    <span className="st stale">
      <Clock size={14} aria-hidden="true" />
      {T.external.stale}
    </span>
  )
  const Icon = ICON[props.status]
  return (
    <span className={`st ${TONE[props.status]}`}>
      {props.status === 'running' ? <span className="live" aria-hidden="true" /> : Icon ? <Icon size={14} aria-hidden="true" /> : null}
      {T.status[props.status]}
    </span>
  )
}
