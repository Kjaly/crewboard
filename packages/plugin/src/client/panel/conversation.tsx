import { useMemo, useRef } from 'react'
import type { ToolDetail } from '@crewboard/core'
import type { TaskDetail } from '../../shared/types.js'
import { MarkdownInline } from './report.js'
import { clock, eventText } from '../summary.js'
import { t, useLang } from '../i18n.js'
import { stabilizeGroupKeys, type KeyedGroup } from './feed-window.js'

type Event = TaskDetail['events'][number]

/** A public explanation: a worker message, the final answer, a human direction, or a runner notice. */
type ProseTurn = { kind: 'message' | 'final' | 'direction' | 'notice' | 'problem'; start: number; end: number; events: Event[]; event: Event; ts: string }
/** One compact disclosure holding every technical step between two prose turns, errors included. */
type TechnicalTurn = { kind: 'technical'; start: number; end: number; events: Event[]; problems: Event[]; latest: Event; ts: string }
export type ConversationTurn = ProseTurn | TechnicalTurn

const ACTOR: Record<ProseTurn['kind'], string> = {
  message: 'panel.activity.roleAgent',
  final: 'panel.activity.roleAgent',
  direction: 'panel.activity.actor.direction',
  notice: 'panel.activity.actor.notice',
  problem: 'panel.activity.actor.problem',
}

const OP: Record<ToolDetail['op'], string> = {
  read: 'panel.activity.op.read',
  write: 'panel.activity.op.write',
  command: 'panel.activity.op.command',
  other: 'panel.activity.op.other',
}

const isTechnical = (event: Event): boolean =>
  event.kind === 'action' || event.kind === 'file' || (event.kind === 'problem' && event.origin === 'tool')

/**
 * The conversation the screen reads: worker messages as prose, a direction or a runner notice set apart,
 * a run-level problem left visible, and every consecutive technical step — actions, edits and the tool
 * errors between them — folded into one disclosure. Chronology is exactly the normalized order.
 */
export function conversationTurns(events: readonly Event[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let group: Event[] = []
  let groupStart = 0
  const flush = (end: number) => {
    if (!group.length) return
    const latest = group.at(-1)!
    turns.push({ kind: 'technical', start: groupStart, end, events: group, problems: group.filter((event) => event.kind === 'problem'), latest, ts: group[0]!.ts })
    group = []
  }
  for (const [index, event] of events.entries()) {
    if (isTechnical(event)) {
      if (!group.length) groupStart = index
      group.push(event)
      continue
    }
    flush(index)
    const kind: ProseTurn['kind'] =
      event.kind === 'message' ? 'message'
      : event.kind === 'final' ? 'final'
      : event.kind === 'steer' ? (event.note ? 'notice' : 'direction')
      : 'problem'
    turns.push({ kind, start: index, end: index + 1, events: [event], event, ts: event.ts })
  }
  flush(events.length)
  return turns
}

/** The localized meaning of a technical step: a known operation plus its target, else the actual reported text. */
export function stepText(event: Event): { op?: string; target: string } {
  const tool = event.tool
  if (!tool) return { target: eventText(event) }
  return { op: t(OP[tool.op]), target: tool.target ?? eventText(event) }
}

/** One line naming what a known tool call is doing, for the persistent Now region. */
export function toolMeaning(tool: ToolDetail): string {
  const meaning = t(OP[tool.op])
  return tool.target ? `${meaning} · ${tool.target}` : meaning
}

/** The public explanation, preferring the bounded multi-line display text over the 200-character summary. */
function bodyOf(event: Event): { text: string; truncated: boolean; compact: boolean } {
  const isPublic = event.kind === 'message' || event.kind === 'final'
  return { text: event.display ?? eventText(event), truncated: event.truncated === true, compact: event.display === undefined && isPublic }
}

function useStableKeys(turns: readonly ConversationTurn[]): string[] {
  const state = useRef<{ prev: KeyedGroup[]; seq: number }>({ prev: [], seq: 0 })
  return useMemo(() => {
    const aligned = stabilizeGroupKeys(state.current.prev, turns, state.current.seq)
    state.current = { prev: aligned.state, seq: aligned.seq }
    return aligned.keys
  }, [turns])
}

function TruncationNote({ truncated, compact }: { truncated: boolean; compact: boolean }) {
  if (!truncated && !compact) return null
  return <p className="orc-turn__truncated">{t(truncated ? 'panel.activity.truncated' : 'panel.activity.compact')}</p>
}

/**
 * The Activity feed itself: one conversation, not a journal. A public message is the primary prose and spans
 * the panel; its actor and time sit subdued above it, never in a left column. Technical steps fold into one
 * disclosure whose summary names the count, the latest step and any tool problem, and whose body lists every
 * step — nothing is erased and one tool error never becomes a whole-task verdict.
 */
export function Conversation({ events, freshFrom, finished }: { events: readonly Event[]; freshFrom?: number; finished?: boolean }) {
  useLang()
  const turns = useMemo(() => conversationTurns(events), [events])
  const keys = useStableKeys(turns)
  if (events.length === 0) return <p className="orc-meta">{t(finished ? 'panel.tabs.noEventsFinished' : 'panel.tabs.noEvents')}</p>
  const fresh = (index: number) => freshFrom !== undefined && index >= freshFrom
  return (
    <ol className="orc-conv">
      {turns.map((turn, index) => {
        const key = keys[index] ?? `${turn.ts}-${index}`
        if (turn.kind === 'technical') {
          const freshTurn = freshFrom !== undefined && turn.end > freshFrom
          return (
            <li key={key} className="orc-conv__item orc-conv__item--technical">
              <details className={`orc-tech${freshTurn ? ' orc-ev--enter' : ''}`}>
                <summary className="orc-tech__summary">
                  <span className="orc-tech__count">{t('panel.activity.steps', { count: turn.events.length })}</span>
                  {turn.problems.length ? <span className="orc-tech__risk">{t('panel.activity.problemCount', { count: turn.problems.length })}</span> : null}
                  <span className="orc-tech__latest" title={stepText(turn.latest).target}>{stepText(turn.latest).target}</span>
                </summary>
                <ol className="orc-tech__list">
                  {turn.events.map((event, step) => {
                    const detail = stepText(event)
                    return (
                      <li key={`${event.ts}-${step}`} className={`orc-tech__step${event.kind === 'problem' ? ' orc-tech__step--problem' : ''}${fresh(turn.start + step) ? ' orc-ev--enter' : ''}`}>
                        {detail.op ? <span className="orc-tech__op">{detail.op}</span> : null}
                        <code className="orc-tech__target" title={detail.target}>{detail.target}</code>
                      </li>
                    )
                  })}
                </ol>
              </details>
            </li>
          )
        }
        const body = bodyOf(turn.event)
        // A streaming message keeps its identity time but is stamped with the time of its last real chunk.
        const said = turn.event.updatedAt ?? turn.ts
        return (
          <li key={key} className={`orc-conv__item orc-conv__item--${turn.kind}`}>
            <article className={`orc-turn orc-turn--${turn.kind}${fresh(turn.start) ? ' orc-ev--enter' : ''}`}>
              <header className="orc-turn__meta">
                <span className={`orc-turn__actor orc-turn__actor--${turn.kind}`}>{t(ACTOR[turn.kind])}</span>
                {turn.kind === 'final' ? <span className="orc-turn__tag">{t('panel.activity.finalTag')}</span> : null}
                <time className="orc-turn__time" dateTime={said}>{clock(said)}</time>
              </header>
              <div className="orc-turn__body">
                {turn.kind === 'message' || turn.kind === 'final' ? <MarkdownInline text={body.text} /> : body.text}
              </div>
              <TruncationNote truncated={body.truncated} compact={body.compact} />
            </article>
          </li>
        )
      })}
    </ol>
  )
}
