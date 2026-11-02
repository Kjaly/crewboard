import { useState } from 'react'
import { T } from '../text.js'

/** The owner's answer to a question the lead escalated: one of the worker's options or their own words, sent once. */
export function QuestionBox(props: { question: string; why: string; options: string[]; onAnswer: (text: string) => Promise<unknown> }) {
  const [own, setOwn] = useState('')
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const send = async (text: string) => {
    if (sending || !text.trim()) return
    setSending(true)
    setFailed(false)
    try {
      await props.onAnswer(text.trim())
      setOwn('')
    } catch {
      // The answer did not reach the server: say so and keep what the owner typed.
      setFailed(true)
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
        {props.options.map((o, i) => (
          <button type="button" key={o} className={`btn press ${i === 0 ? 'primary' : ''}`} disabled={sending} onClick={() => void send(o)}>
            {o}
          </button>
        ))}
      </div>
      <form
        className="own"
        onSubmit={(e) => {
          e.preventDefault()
          void send(own)
        }}
      >
        <label>
          <span className="sr-only">{T.question.own}</span>
          <input aria-label={T.question.own} placeholder={T.question.placeholder} value={own} disabled={sending} onChange={(e) => setOwn(e.target.value)} />
        </label>
        <button type="submit" className="btn press" disabled={sending || !own.trim()}>
          {T.question.send}
        </button>
      </form>
      {failed && (
        <p className="fail" role="alert">
          {T.question.failed}
        </p>
      )}
    </section>
  )
}
