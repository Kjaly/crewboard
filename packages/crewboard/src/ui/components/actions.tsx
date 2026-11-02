import { useState } from 'react'
import { availableActions } from '../../model/project.js'
import type { AssignmentView, ProviderId, RequestAction } from '../../model/types.js'
import { AGENTS } from '../agents.js'
import { T, providerLabel } from '../text.js'


export type ActionMode = 'idle' | 'clarify' | 'reopen' | 'revive' | 'handoff'
const NEEDS_TEXT: ReadonlySet<RequestAction> = new Set(['clarify', 'reopen', 'revive'])

/** The requests the owner may send on a node; each goes to the lead, which decides. */
export function Actions(props: {
  node: AssignmentView
  leadOnline: boolean
  mode: ActionMode
  onMode: (mode: ActionMode) => void
  onRequest: (action: RequestAction, text?: string, provider?: ProviderId) => Promise<unknown>
  onEmergencyStop: () => Promise<unknown>
  onDiscuss: () => Promise<unknown>
}) {
  const { node, mode, onMode } = props
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const actions = availableActions(node)

  const run = async (fn: () => Promise<unknown>) => {
    if (sending) return
    setSending(true)
    setFailed(false)
    try {
      await fn()
      setText('')
      onMode('idle')
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }
  const click = (a: RequestAction | 'emergency_stop') => {
    // Irreversible and without the lead: a second, explicit click carries it out.
    if (a === 'emergency_stop') {
      if (!confirming) return setConfirming(true)
      setConfirming(false)
      return void run(props.onEmergencyStop)
    }
    if (a === 'discuss') return void run(props.onDiscuss)
    if (a === 'handoff') return onMode(mode === 'handoff' ? 'idle' : 'handoff')
    if (NEEDS_TEXT.has(a)) return onMode(mode === a ? 'idle' : (a as ActionMode))
    void run(() => props.onRequest(a))
  }

  return (
    <section className="actions" aria-label={T.actions}>
      <div className="answers">
        {actions.map((a) => (
          <button type="button" key={a} className={`btn press ${a === 'emergency_stop' ? 'danger' : ''}`} disabled={sending} aria-pressed={mode === a ? true : undefined} onClick={() => click(a)}>
            {a === 'emergency_stop' ? (confirming ? T.emergencyConfirm : T.emergencyStop) : T.action[a]}
          </button>
        ))}
      </div>
      {confirming && <p className="hint-line">{T.emergencyHint}</p>}
      {!props.leadOnline && actions.includes('emergency_stop') && <p className="hint-line">{T.leadAwayHint}</p>}
      {mode === 'handoff' && (
        <fieldset className="answers handoff">
          <legend className="sr-only">{T.handoffTo}</legend>
          {AGENTS.map((a) => a.id).filter((p) => p !== node.provider).map((p) => (
            <button type="button" key={p} className="btn press" disabled={sending} onClick={() => void run(() => props.onRequest('handoff', undefined, p))}>
              {providerLabel(p)}
            </button>
          ))}
        </fieldset>
      )}
      {(mode === 'clarify' || mode === 'reopen' || mode === 'revive') && (
        <form
          className="own"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) void run(() => props.onRequest(mode, text.trim()))
          }}
        >
          <label>
            <span className="sr-only">{T.actionText}</span>
            <input aria-label={T.actionText} value={text} disabled={sending} onChange={(e) => setText(e.target.value)} />
          </label>
          <button type="submit" className="btn press" disabled={sending || !text.trim()}>
            {T.actionSend}
          </button>
        </form>
      )}
      {failed && (
        <p className="fail" role="alert">
          {T.requestFailed}
        </p>
      )}
    </section>
  )
}
