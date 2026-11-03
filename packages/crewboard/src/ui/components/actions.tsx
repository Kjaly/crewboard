import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { availableActions } from '../../model/project.js'
import type { AssignmentView, ProviderId, RequestAction } from '../../model/types.js'
import type { Api, HandoffPick } from '../api.js'
import { ArrowClockwise, ArrowsLeftRight, ArrowUUpLeft, CaretRight, ChatsCircle, Copy, HourglassMedium, Info, NotePencil, Octagon, Play, Stop, XCircle } from '../icons.js'
import { T } from '../text.js'
import { Handoff } from './handoff.js'
import { requestText } from './request-line.js'

export type ActionMode = 'idle' | 'clarify' | 'reopen' | 'revive' | 'handoff'
const NEEDS_TEXT: ReadonlySet<RequestAction> = new Set(['clarify', 'reopen', 'revive'])
const ORDER: RequestAction[] = ['clarify', 'handoff', 'start_now', 'reopen', 'revive', 'stop', 'cancel', 'discuss']
const ICON: Record<RequestAction, typeof Stop> = { clarify: NotePencil, handoff: ArrowsLeftRight, start_now: Play, reopen: ArrowUUpLeft, revive: ArrowClockwise, stop: Stop, cancel: XCircle, discuss: ChatsCircle }
const HOLD_MS = 1200
const COPIED_MS = 1600

/** The requests the owner may send on a node; each goes to the lead, which decides. */
export function Actions(props: {
  loadModels?: Api['models']
  node: AssignmentView
  leadOnline: boolean
  mode: ActionMode
  onMode: (mode: ActionMode) => void
  onRequest: (action: RequestAction, text?: string, provider?: ProviderId, pick?: HandoffPick) => Promise<unknown>
  onEmergencyStop: () => Promise<unknown>
  onDiscuss: () => Promise<unknown>
}) {
  const { node, mode, onMode } = props
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const rows = useRef<Partial<Record<RequestAction, HTMLButtonElement | null>>>({})
  const field = useRef<HTMLTextAreaElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const actions = availableActions(node)
  const asks = ORDER.filter((a) => actions.includes(a))
  const canStopNow = actions.includes('emergency_stop')
  const pending = node.request?.state === 'pending' ? node.request : undefined
  const handoff = node.pendingRun ?? node

  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (NEEDS_TEXT.has(mode as RequestAction)) field.current?.focus()
  }, [mode])

  /** Runs a send once at a time; true when it went through. */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (sending) return false
    setSending(true)
    setFailed(false)
    try {
      await fn()
      setText('')
      onMode('idle')
      return true
    } catch {
      setFailed(true)
      return false
    } finally {
      setSending(false)
    }
  }
  const discuss = () =>
    run(async () => {
      await props.onDiscuss()
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    })
  const click = (a: RequestAction) => {
    if (a === 'discuss') return void discuss()
    if (a === 'handoff' || NEEDS_TEXT.has(a)) return onMode(mode === a ? 'idle' : (a as ActionMode))
    void run(() => props.onRequest(a))
  }
  const send = () => {
    const body = text.trim()
    if (body && mode !== 'idle' && mode !== 'handoff') void run(() => props.onRequest(mode, body))
  }
  const fieldKeys = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onMode('idle')
      if (mode !== 'idle' && mode !== 'handoff') rows.current[mode]?.focus()
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      send()
    }
  }

  return (
    <section className="na" aria-label={T.actions}>
      {pending && (
        <div className="na-pending" role="status">
          <HourglassMedium size={16} aria-hidden="true" />
          <span>{requestText(pending)}</span>
        </div>
      )}
      {asks.length > 0 && (
        <>
          <div className="na-cap">
            <span>{T.askLead}</span>
            <button type="button" className="na-tip" aria-label={T.askLeadInfoLabel} aria-describedby="na-tip-text">
              <Info size={15} aria-hidden="true" />
              <span className="na-bubble" role="tooltip" id="na-tip-text">
                {T.askLeadInfo}
              </span>
            </button>
          </div>
          <div className="na-list">
            {asks.map((a) => {
              const Icon = ICON[a]
              const open = mode === a
              const expandable = a === 'handoff' || NEEDS_TEXT.has(a)
              return (
                <div key={a} className="na-act" data-open={open}>
                  <button
                    type="button"
                    className="na-row"
                    ref={(el) => {
                      rows.current[a] = el
                    }}
                    disabled={sending && !expandable}
                    aria-expanded={expandable ? open : undefined}
                    onClick={() => click(a)}
                  >
                    <span className="na-ic">
                      <Icon size={15} aria-hidden="true" />
                    </span>
                    <span>
                      <span className="na-tt">{T.actionTitle[a]}</span>
                      {a === 'discuss' ? (
                        <span className="na-sub na-state" data-done={copied}>
                          <span aria-hidden={copied}>{T.actionEffect[a]}</span>
                          <span aria-hidden={!copied}>{T.discussDone}</span>
                        </span>
                      ) : (
                        <span className="na-sub">{T.actionEffect[a]}</span>
                      )}
                    </span>
                    {expandable ? <CaretRight size={13} className="na-chev" aria-hidden="true" /> : a === 'discuss' ? <Copy size={13} className="na-chev flat" aria-hidden="true" /> : <span />}
                  </button>
                  {open && <Body>{a === 'handoff' ? <Handoff loadModels={props.loadModels} from={node.provider} {...(handoff.model ? { fromModel: handoff.model } : {})} {...(handoff.effort ? { fromEffort: handoff.effort } : {})} sending={sending} onSend={(provider, pick) => void run(() => props.onRequest('handoff', undefined, provider, pick))} /> : (
                    <>
                      <textarea ref={field} className="na-ta" aria-label={T.actionText} placeholder={a === 'clarify' ? T.actionPlaceholder : undefined} value={text} disabled={sending} onChange={(e) => setText(e.target.value)} onKeyDown={fieldKeys} />
                      <div className="na-foot">
                        <span>
                          <kbd className="na-kbd">{isMac() ? '⌘' : 'Ctrl'}</kbd> <kbd className="na-kbd">Enter</kbd> {T.actionSendHint}
                        </span>
                        <button type="button" className="na-send" disabled={sending || !text.trim()} onClick={send}>
                          {T.actionSendLead}
                        </button>
                      </div>
                    </>
                  )}</Body>}
                </div>
              )
            })}
          </div>
        </>
      )}
      {canStopNow && (
        <>
          {asks.length > 0 && <hr className="na-hr" />}
          <HoldStop onHold={() => run(props.onEmergencyStop)} />
          {!props.leadOnline && <p className="hint-line">{T.leadAwayHint}</p>}
        </>
      )}
      {failed && (
        <p className="fail" role="alert">
          {T.requestFailed}
        </p>
      )}
    </section>
  )
}

function Body(props: { children: ReactNode }) {
  return (
    <div className="na-body">
      <div>
        <div className="na-inner">{props.children}</div>
      </div>
    </div>
  )
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/** The emergency stop: irreversible and without the lead, so it needs a deliberate hold, by pointer or by Space/Enter. */
function HoldStop(props: { onHold: () => Promise<boolean> }) {
  const [phase, setPhase] = useState<'idle' | 'holding' | 'stopped'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const stopped = useRef(false)
  useEffect(() => () => clearTimeout(timer.current), [])

  const start = () => {
    if (timer.current || stopped.current) return
    setPhase('holding')
    timer.current = setTimeout(() => {
      timer.current = undefined
      stopped.current = true
      setPhase('stopped')
      void props.onHold().then((ok) => {
        if (ok) return
        stopped.current = false
        setPhase('idle')
      })
    }, HOLD_MS)
  }
  const end = () => {
    if (!timer.current) return
    clearTimeout(timer.current)
    timer.current = undefined
    setPhase('idle')
  }
  const done = phase === 'stopped'

  return (
    <button
      type="button"
      className="na-hold"
      data-phase={phase}
      aria-label={T.holdStopLabel}
      onPointerDown={(e) => {
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // No pointer capture here: leaving the button still ends the hold.
        }
        start()
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
      onKeyDown={(e) => {
        if (e.key !== ' ' && e.key !== 'Enter') return
        e.preventDefault()
        if (!e.repeat) start()
      }}
      onKeyUp={(e) => {
        if (e.key === ' ' || e.key === 'Enter') end()
      }}
      onBlur={end}
    >
      <span className="na-ic">
        <Octagon size={15} aria-hidden="true" />
      </span>
      <span>
        <span className="na-tt">{done ? T.holdStopped : T.emergencyStop}</span>
        <span className="na-sub">{done ? T.holdStoppedHint : T.holdStopHint}</span>
      </span>
    </button>
  )
}
