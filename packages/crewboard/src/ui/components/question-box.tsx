import { useState } from 'react'
import type { SendResult } from '../api.js'
import { T } from '../text.js'
import { useDraft } from '../drafts.js'

/** The owner's answer to a question the lead escalated: one of the worker's options or their own words, sent once. */
export function QuestionBox(props: { draftKey?: string; question: string; why: string; options: string[]; onAnswer: (text: string) => Promise<SendResult> }) {
  const [own, setOwn] = useDraft(JSON.stringify([props.draftKey, 'answer', props.question]))
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState<string>()
  const [sent, setSent] = useState(false)
  const send = async (text: string) => {
    if (sending || sent || !text.trim()) return
    setSending(true)
    setFailed(undefined)
    try {
      const result = await props.onAnswer(text.trim())
      setSent(true)
      if (result.refreshFailed) setFailed(T.refreshFailed)
      setOwn('')
    } catch (error) {
      // The answer did not reach the server: say so and keep what the owner typed.
      setFailed(error instanceof Error ? error.message : T.question.failed)
    } finally {
      setSending(false)
    }
  }
  return (
    <section className="qbox" aria-label={props.question}>
      <div className="via">
        {T.question.via}: {props.why}
      </div>
      <p>{props.question}</p>
      <div className="answers">
        {props.options.map((o) => (
          <button type="button" key={o} className="btn press" disabled={sending || sent} onClick={() => void send(o)}>
            {o}
          </button>
        ))}
      </div>
      {props.options.length > 0 && <p className="hint-line">{T.question.optionHint}</p>}
      <form
        className="own"
        onSubmit={(e) => {
          e.preventDefault()
          void send(own)
        }}
      >
        <label>
          <span className="sr-only">{T.question.own}</span>
          <input aria-label={T.question.own} placeholder={T.question.placeholder} value={own} disabled={sending || sent} onChange={(e) => setOwn(e.target.value)} />
        </label>
        <button type="submit" className="btn press" disabled={sending || sent || !own.trim()}>
          {T.question.send}
        </button>
      </form>
      {failed && (
        <p className="fail" role="alert">
          {failed}
        </p>
      )}
    </section>
  )
}
