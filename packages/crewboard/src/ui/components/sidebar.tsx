import { useCallback, useState } from 'react'
import type { GoalSummary, ProjectSummary } from '../../owner.js'
import { CaretDown, CheckCircle, HandWaving, Pause, Question } from '../icons.js'
import { T } from '../text.js'
import { Avatar } from './badges.js'

type Kind = 'ask' | 'run' | 'lead' | 'pause' | 'done'
const ORDER: Record<Kind, number> = { ask: 0, run: 1, lead: 2, pause: 3, done: 4 }
const FINISHED = new Set(['done', 'cancelled', 'abandoned'])
const CLOSED_KEY = 'crewboard.sidebar.closed'
const FINISHED_KEY = 'crewboard.sidebar.finished'

/** What a goal row shows first: waiting for the owner, running, waiting for the lead, paused, or finished. */
export function goalKind(g: GoalSummary): Kind {
  if (FINISHED.has(g.status)) return 'done'
  if (g.status === 'waiting_owner' || g.counts.waiting_owner > 0) return 'ask'
  if (g.status === 'paused') return 'pause'
  if (g.counts.running + g.counts.queued > 0) return 'run'
  if (g.status === 'waiting_answer' || g.counts.waiting_lead > 0) return 'lead'
  return 'run'
}

/** Open goals in the order of the owner's attention (stable inside a kind); finished ones last, the latest first. */
export function orderGoals(goals: GoalSummary[]): { open: Array<{ g: GoalSummary; kind: Kind }>; finished: GoalSummary[] } {
  const all = goals.map((g) => ({ g, kind: goalKind(g) }))
  const open = all.filter((x) => x.kind !== 'done').sort((a, b) => ORDER[a.kind] - ORDER[b.kind])
  const finished = all.filter((x) => x.kind === 'done').map((x) => x.g).sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
  return { open, finished }
}

/** A set of strings kept in localStorage; storage that is missing or broken only means it is not remembered. */
function useRemembered(key: string): [ReadonlySet<string>, (item: string) => void] {
  const [set, setSet] = useState<ReadonlySet<string>>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback(
    (item: string) =>
      setSet((prev) => {
        const next = new Set(prev)
        if (!next.delete(item)) next.add(item)
        try {
          localStorage.setItem(key, JSON.stringify([...next]))
        } catch {
          // Storage unavailable (private window): the choice lasts until the page closes.
        }
        return next
      }),
    [key],
  )
  return [set, toggle]
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate()

/** When a goal finished: «today 01:30», «yesterday 18:05», or the date. */
function finishedWhen(iso: string | undefined, now: Date): string {
  const at = iso ? new Date(iso) : undefined
  if (!at || Number.isNaN(at.getTime())) return ''
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000)
  if (dayKey(at) === dayKey(now)) return `${T.today} ${time}`
  if (days === 1) return `${T.yesterday} ${time}`
  return at.toLocaleDateString(T.locale, { day: 'numeric', month: 'short' })
}

/** The short line under a title: what is going on in the goal, in the owner's order of concern. */
function lineOf(g: GoalSummary, kind: Kind, now: Date): string {
  if (kind === 'done') return finishedWhen(g.finishedAt, now)
  if (kind === 'pause') return T.goalPaused
  const parts = [g.counts.waiting_owner && T.waitingYou(g.counts.waiting_owner), g.counts.waiting_lead && T.waitingLead(g.counts.waiting_lead), g.counts.running && T.running(g.counts.running), g.counts.queued && T.queued(g.counts.queued)].filter(Boolean)
  if (parts.length > 0) return parts.join(' · ')
  return kind === 'lead' ? T.goalWaitsLead : T.goalNoWork
}

const MARK: Record<Kind, () => React.ReactNode> = {
  ask: () => <HandWaving size={14} aria-hidden="true" />,
  run: () => <i className="live" aria-hidden="true" />,
  lead: () => <Question size={14} aria-hidden="true" />,
  pause: () => <Pause size={14} aria-hidden="true" />,
  done: () => <CheckCircle size={14} aria-hidden="true" />,
}

function GoalRow(props: { repo: string; g: GoalSummary; kind: Kind; current: boolean; now: Date; onPick: (project: string, goalId: string) => void }) {
  const { g, kind } = props
  const line = lineOf(g, kind, props.now)
  return (
    <li>
      <button type="button" className={`sb-goal press ${kind === 'done' ? 'fin' : ''}`} aria-current={props.current ? 'page' : undefined} aria-label={`${g.title}. ${line}`} onClick={() => props.onPick(props.repo, g.goalId)}>
        <span className={`sb-mark ${kind}`}>{MARK[kind]()}</span>
        <span className="sb-body">
          <span className="sb-title">{g.title}</span>
          <span className="sb-line">
            <span className="sb-lead">
              <Avatar provider="lead" leadClient={g.lead} />
            </span>
            <span className={kind === 'ask' ? 'ask' : undefined}>{line}</span>
          </span>
        </span>
        {kind === 'ask' && g.counts.waiting_owner > 0 && <span className="sb-badge">{g.counts.waiting_owner}</span>}
      </button>
    </li>
  )
}

function Project(props: { p: ProjectSummary; goalId?: string; isCurrent: boolean; closed: boolean; finishedOpen: boolean; onClosed: () => void; onFinished: () => void; now: Date; onPick: (project: string, goalId: string) => void }) {
  const { p, closed } = props
  const { open, finished } = orderGoals(p.goals)
  const waiting = p.goals.reduce((n, g) => n + g.counts.waiting_owner, 0)
  const running = open.filter((x) => x.kind === 'run').length
  // The goal on screen stays visible even when its group is folded.
  const finishedShown = props.finishedOpen || (props.isCurrent && finished.some((g) => g.goalId === props.goalId))
  const row = (g: GoalSummary, kind: Kind) => <GoalRow key={g.goalId} repo={p.repo} g={g} kind={kind} current={props.isCurrent && g.goalId === props.goalId} now={props.now} onPick={props.onPick} />
  const listId = `sb-${p.repo}`
  const hidden = closed ? { inert: '' as unknown as boolean, 'aria-hidden': true } : {}
  return (
    <section className={`proj ${closed ? 'closed' : ''}`}>
      <h2 title={p.repo}>
        <button type="button" className="sb-head" aria-expanded={!closed} aria-controls={listId} onClick={props.onClosed}>
          <CaretDown className="sb-caret" size={11} aria-hidden="true" />
          <span className="sb-name">{p.name}</span>
          {waiting > 0 ? (
            <span className="sb-badge" role="img" aria-label={T.waitingN(waiting)}>
              {waiting}
            </span>
          ) : (
            running > 0 && <span className="sb-count">{T.running(running)}</span>
          )}
        </button>
      </h2>
      <div className="sb-list" id={listId} {...hidden}>
        <div>
          <ul>
            {open.map((x) => row(x.g, x.kind))}
          </ul>
          {finished.length > 0 && (
            <>
              <button type="button" className="sb-fold" aria-expanded={finishedShown} onClick={props.onFinished}>
                <CaretDown className="sb-caret" size={11} aria-hidden="true" />
                {T.finishedGroup(finished.length)}
              </button>
              {finishedShown && <ul>{finished.map((g) => row(g, 'done'))}</ul>}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/** Every project with its goals (one conversation with the lead each): where each stands and how much waits for the owner. */
export function Sidebar(props: { projects: ProjectSummary[]; project?: string; goalId?: string; onPick: (project: string, goalId: string) => void; drawer: boolean; open: boolean; footer?: React.ReactNode }) {
  const hidden = props.drawer && !props.open
  const [closed, toggleClosed] = useRemembered(CLOSED_KEY)
  const [finishedOpen, toggleFinished] = useRemembered(FINISHED_KEY)
  const now = new Date()
  return (
    <nav className={`side-nav ${props.drawer ? 'drawer' : ''} ${props.open ? 'on' : ''}`} aria-label={T.sidebar} {...(hidden ? { inert: '' as unknown as boolean } : {})}>
      <div className="brand">{T.appTitle}</div>
      {props.projects.map((p) => (
        <Project
          key={p.repo}
          p={p}
          goalId={props.goalId}
          isCurrent={p.repo === props.project}
          closed={closed.has(p.repo)}
          finishedOpen={finishedOpen.has(p.repo)}
          onClosed={() => toggleClosed(p.repo)}
          onFinished={() => toggleFinished(p.repo)}
          now={now}
          onPick={props.onPick}
        />
      ))}
      {props.footer}
    </nav>
  )
}
