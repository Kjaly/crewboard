import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Step } from '../../workers/steps.js'
import { type Api, isNotFound } from '../api.js'
import { ArrowDown, CaretRight, ChatText, Check, CheckCircle, CircleNotch, FileText, PencilSimple, Terminal, Warning, Wrench, X } from '../icons.js'
import { T } from '../text.js'

type Size = 'line' | 'short' | 'full'
type View = 'messages' | 'all'
/** `thought` is newer than the server types here and may be absent from older servers. */
type FeedStep = Omit<Step, 'kind'> & { kind: Step['kind'] | 'thought' }
type WorkKind = 'command' | 'read' | 'write' | 'tool'
type Item = { type: 'step'; step: FeedStep } | { type: 'work'; id: number; steps: FeedStep[] }

const POLL_MS = 2000
const SILENT_MS = 5 * 60_000
const SHORT_ROWS = 3
const SETTLE_MS = 30_000
const SETTLE_FIRST_MS = 500
const SETTLE_MAX_MS = 4000
const NEXT_SIZE: Record<Size, Size> = { line: 'short', short: 'full', full: 'line' }
const KIND_ICON = { thought: ChatText, message: ChatText, command: Terminal, read: FileText, write: PencilSimple, tool: Wrench, problem: Warning, final: CheckCircle } as const

/** Folds a response into the list by `i`: the API repeats a step that is still running with its newer text and status. */
export function mergeSteps(have: readonly FeedStep[], incoming: readonly FeedStep[]): FeedStep[] {
  const byIndex = new Map(have.map((s) => [s.i, s]))
  for (const s of incoming) byIndex.set(s.i, s)
  return [...byIndex.values()].sort((a, b) => a.i - b.i)
}

const isWork = (s: FeedStep): boolean => s.kind === 'command' || s.kind === 'read' || s.kind === 'write' || s.kind === 'tool'

/** Messages, thoughts, problems and the final answer stay rows; consecutive work steps between them fold into one. */
export function foldSteps(steps: readonly FeedStep[]): Item[] {
  const items: Item[] = []
  for (const step of steps) {
    const tail = items.at(-1)
    if (!isWork(step)) items.push({ type: 'step', step })
    else if (tail?.type === 'work') tail.steps.push(step)
    else items.push({ type: 'work', id: step.i, steps: [step] })
  }
  return items
}

/** "5 commands, 2 files": the count of each kind in a folded run of work steps. */
function foldLabel(steps: readonly FeedStep[]): string {
  const count = (...kinds: WorkKind[]) => steps.filter((s) => (kinds as string[]).includes(s.kind)).length
  const f = T.feed.fold
  const parts = [f.commands(count('command')), f.files(count('read', 'write')), f.tools(count('tool'))]
  return parts.filter((_, k) => [count('command'), count('read', 'write'), count('tool')][k]).join(', ')
}

/** m:ss, or h:mm:ss from an hour on. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const sec = String(total % 60).padStart(2, '0')
  const min = Math.floor(total / 60)
  return min < 60 ? `${min}:${sec}` : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}:${sec}`
}

function span(ms: number): string {
  const u = T.feed.units
  if (ms < 1000) return `${Math.round(ms)} ${u.ms}`
  if (ms < 60_000) return `${(ms / 1000).toLocaleString(T.locale, { maximumFractionDigits: ms < 10_000 ? 1 : 0 })} ${u.s}`
  return `${Math.floor(ms / 60_000)} ${u.min} ${Math.round((ms % 60_000) / 1000)} ${u.s}`
}

const sizeKey = (assignmentId: string) => `crewboard.feed.${assignmentId}`
const viewKey = (assignmentId: string) => `crewboard.feed.view.${assignmentId}`

function initialView(assignmentId: string): View {
  try {
    return localStorage.getItem(viewKey(assignmentId)) === 'all' ? 'all' : 'messages'
  } catch {
    return 'messages'
  }
}

function initialSize(assignmentId: string): Size {
  try {
    const saved = localStorage.getItem(sizeKey(assignmentId))
    if (saved === 'line' || saved === 'short' || saved === 'full') return saved
  } catch {
    // Storage unavailable: fall back to the screen-size default.
  }
  const narrow = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches
  return narrow ? 'line' : 'short'
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** The live feed of one run; only an untouched feed folds when its run ends. */
export function RunFeed(props: { api: Api; project: string; assignmentId: string; runId: string; running: boolean; onRead?: () => void }) {
  const { api, project, assignmentId, runId, running } = props
  const [steps, setSteps] = useState<FeedStep[]>([])
  const [context, setContext] = useState<{ used: number; size: number } | undefined>()
  const [size, setSize] = useState<Size>(() => initialSize(assignmentId))
  const [view, setView] = useState<View>(() => initialView(assignmentId))
  const [folds, setFolds] = useState<ReadonlySet<number>>(new Set())
  const [failed, setFailed] = useState(false)
  const engaged = useRef(size === 'full')
  const [endedSize, setEndedSize] = useState<Size>('line')
  const [details, setDetails] = useState<ReadonlySet<number>>(new Set())
  const [fresh, setFresh] = useState(false)
  const next = useRef(0)
  const finished = useRef(false)
  const gone = useRef<string>()
  const list = useRef<HTMLUListElement>(null)
  const atBottom = useRef(true)
  const seenCount = useRef(0)
  const rendered = useRef(new Set<number>())
  const newSteps = new Set(steps.filter((s) => !rendered.current.has(s.i)).map((s) => s.i))
  useEffect(() => {
    for (const s of steps) rendered.current.add(s.i)
  }, [steps])
  const now = useNow(running)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Resolves to whether the run may still produce steps.
    const pull = async (): Promise<boolean> => {
      if (gone.current === runId) return false
      try {
        const res = await api.steps(project, runId, next.current)
        if (cancelled) return false
        setFailed(false)
        next.current = res.next
        finished.current = res.done
        setSteps((have) => mergeSteps(have, res.steps))
        setContext(res.context)
        return !res.done
      } catch (error) {
        if (cancelled) return false
        setFailed(true)
        // A run the server does not know will not appear: stop asking. Any other failure is retried next tick.
        if (isNotFound(error)) {
          gone.current = runId
          return false
        }
        return !cancelled
      }
    }
    if (!running) {
      // The node stopped running: keep pulling with backoff until the run reports done, so the last steps and
      // durations land, but give up after SETTLE_MS.
      const until = Date.now() + SETTLE_MS
      let wait = SETTLE_FIRST_MS
      const settle = async () => {
        if (finished.current || cancelled) return
        const more = await pull()
        if (cancelled || !more || Date.now() + wait > until) return
        timer = setTimeout(() => void settle(), wait)
        wait = Math.min(wait * 2, SETTLE_MAX_MS)
      }
      void settle()
      return () => {
        cancelled = true
        if (timer) clearTimeout(timer)
      }
    }
    const tick = async () => {
      const more = typeof document !== 'undefined' && document.hidden ? true : await pull()
      if (!cancelled && more) timer = setTimeout(() => void tick(), POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [api, project, runId, running])

  const current = running || engaged.current ? size : endedSize
  const reading = () => {
    engaged.current = true
    props.onRead?.()
  }
  const cycle = () => {
    reading()
    const to = NEXT_SIZE[current]
    atBottom.current = true
    setFresh(false)
    if (!running) setEndedSize(to)
    setSize(to)
    try {
      localStorage.setItem(sizeKey(assignmentId), to)
    } catch {
      // Storage unavailable: the size lasts until the page closes.
    }
  }

  const switchView = () => {
    reading()
    const to: View = view === 'all' ? 'messages' : 'all'
    setView(to)
    try {
      localStorage.setItem(viewKey(assignmentId), to)
    } catch {
      // Storage unavailable: the view lasts until the page closes.
    }
  }
  const toggleFold = (id: number) =>
    setFolds((have) => {
      const out = new Set(have)
      if (!out.delete(id)) out.add(id)
      return out
    })

  // Expanded: follow new steps only while the reader is at the bottom; otherwise offer a way down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching view changes the list height, so the scroll is applied again.
  useLayoutEffect(() => {
    const el = list.current
    const grew = steps.length > seenCount.current
    seenCount.current = steps.length
    if (!el || current !== 'full') return
    if (atBottom.current) el.scrollTop = el.scrollHeight
    else if (grew) setFresh(true)
  }, [steps, current, view])

  const onScroll = () => {
    reading()
    const el = list.current
    if (!el) return
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    if (atBottom.current) setFresh(false)
  }
  const toBottom = () => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
    atBottom.current = true
    setFresh(false)
  }
  const toggleDetail = (i: number) =>
    setDetails((have) => {
      const out = new Set(have)
      if (!out.delete(i)) out.add(i)
      return out
    })

  const first = steps[0]
  const last = steps.at(-1)
  const startedAt = first ? Date.parse(first.ts) : undefined
  const endedAt = last ? Date.parse(last.ts) : undefined
  const silentMin = !failed && running && last?.status !== 'running' && endedAt !== undefined && now - endedAt > SILENT_MS ? Math.floor((now - endedAt) / 60_000) : 0
  const pct = context && context.size > 0 ? Math.min(100, Math.round((context.used / context.size) * 100)) : undefined
  const items: Item[] = view === 'all' ? steps.map((step) => ({ type: 'step', step })) : foldSteps(steps)
  const rows = current === 'short' ? items.slice(-SHORT_ROWS) : items

  return (
    // The tree's arrow-key and letter shortcuts belong to the rows, not to the controls in here.
    <section className="feed" data-size={current} data-view={view} data-running={running} aria-label={T.feed.label} onFocus={() => { if (running) reading() }} onPointerEnter={() => { if (running) reading() }} onKeyDown={(e) => e.stopPropagation()}>
      <div className="feed-h">
        <button type="button" className="feed-toggle press" data-size={current} aria-label={current === 'full' ? T.feed.collapse : T.feed.expand} onClick={cycle}>
          <CaretRight size={12} aria-hidden="true" />
        </button>
        {running ? (
          <>
            {startedAt !== undefined && <span className="feed-stat">{clock(now - startedAt)}</span>}
            <span className="feed-stat">{T.feed.steps(steps.length)}</span>
            {pct !== undefined && <progress className="feed-ctx" aria-label={T.feed.context(pct)} max={100} value={pct} />}
            {silentMin > 0 && <span className="feed-silent">{T.feed.silent(silentMin)}</span>}
            {current === 'line' && last && <span className="feed-last">{last.text}</span>}
          </>
        ) : (
          <span className="feed-stat">{T.feed.steps(steps.length)}{startedAt !== undefined && endedAt !== undefined ? ` · ${span(endedAt - startedAt)}` : ''}</span>
        )}
        {current !== 'line' && (
          <button type="button" className="feed-view press" aria-pressed={view === 'all'} onClick={switchView}>
            {T.feed.allSteps}
          </button>
        )}
      </div>
      {failed && <p className="hint-line">{T.feed.loadFailed}</p>}
      {current !== 'line' && (
        <div className="feed-body">
          <ul className="feed-list" ref={list} onScroll={onScroll}>
            {rows.length === 0 && running && !failed && <li className="feed-empty">{T.feed.waiting}</li>}
            {rows.map((item) =>
              item.type === 'step' ? (
                <StepRow key={item.step.i} fresh={newSteps.has(item.step.i)} step={item.step} open={details.has(item.step.i)} onToggle={() => toggleDetail(item.step.i)} />
              ) : (
                <li key={`w${item.id}`} className={`feed-row feed-fold ${newSteps.has(item.id) ? 'feed-new-row' : ''}`}>
                  <FoldRow steps={item.steps} open={folds.has(item.id)} onToggle={() => toggleFold(item.id)} />
                  {folds.has(item.id) && (
                    <ul className="feed-sub">
                      {item.steps.map((s) => (
                        <StepRow key={s.i} step={s} open={details.has(s.i)} onToggle={() => toggleDetail(s.i)} />
                      ))}
                    </ul>
                  )}
                </li>
              ),
            )}
          </ul>
          {fresh && (
            <button type="button" className="feed-new press" onClick={toBottom}>
              <ArrowDown size={12} aria-hidden="true" />
              {T.feed.newSteps}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function FoldRow(props: { steps: readonly FeedStep[]; open: boolean; onToggle: () => void }) {
  const { steps, open, onToggle } = props
  const running = steps.some((s) => s.status === 'running')
  const failed = steps.some((s) => s.status === 'failed')
  const total = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
  return (
    <button type="button" className="feed-line feed-folded" aria-expanded={open} onClick={onToggle}>
      <CaretRight size={12} aria-hidden="true" className="feed-caret" />
      <span className="feed-text">{foldLabel(steps)}</span>
      {running && (
        <span className="feed-state">
          <span className="sr">{T.feed.stepStatus.running}</span>
          <CircleNotch size={13} className="spin" aria-hidden="true" />
        </span>
      )}
      {failed && !running && <X size={13} aria-hidden="true" className="feed-failed" />}
      {total > 0 && <span className="feed-dur">{span(total)}</span>}
    </button>
  )
}

function StepRow(props: { step: FeedStep; fresh?: boolean; open: boolean; onToggle: () => void }) {
  const { step: s, open, onToggle } = props
  const Icon = KIND_ICON[s.kind]
  const body = (
    <>
      <Icon size={14} aria-hidden="true" className="feed-kind" />
      <span className="feed-text">{s.text}</span>
      {s.status && (
        <span className="feed-state">
          <span className="sr">{T.feed.stepStatus[s.status]}</span>
          {s.status === 'running' ? <CircleNotch size={13} className="spin" aria-hidden="true" /> : s.status === 'done' ? <Check size={13} aria-hidden="true" /> : <X size={13} aria-hidden="true" />}
        </span>
      )}
      {s.durationMs !== undefined && <span className="feed-dur">{span(s.durationMs)}</span>}
    </>
  )
  return (
    <li className={`feed-row ${props.fresh ? 'feed-new-row' : ''} ${s.kind === 'thought' ? 'thought' : ''} ${s.kind === 'message' || s.kind === 'final' ? 'say' : ''} ${s.kind === 'problem' ? 'problem' : ''} ${s.status === 'failed' ? 'failed' : ''}`}>
      {(s.kind === 'message' || s.kind === 'thought' || s.kind === 'final') && s.detail ? (
        <button type="button" className="feed-line" aria-expanded={open} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <div className="feed-line">{body}</div>
      )}
      {open && s.detail && <div className="feed-detail">{s.detail}</div>}
    </li>
  )
}
