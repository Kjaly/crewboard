import { useState } from 'react'
import type { TaskSnapshot } from '../../shared/types.js'
import { t } from '../i18n.js'
import { failureHint, failureText, incompleteText } from '../summary.js'

type Attempt = NonNullable<TaskSnapshot['lastAttempt']>

/** The move the block offers: a login without a command (dsh keeps its keys in its settings) is a plain retry. */
export function attemptMove(attempt: Attempt): Attempt['action'] {
  if (attempt.action === 'login' && !(attempt.reason?.code === 'auth_expired' && attempt.reason.login)) return 'retry'
  return attempt.action
}

/** What the attempt ended with, in words: the failure reason, else the outcome itself. */
function reasonWords(attempt: Attempt, task: TaskSnapshot): string {
  if (attempt.reason) return failureText(attempt.reason)
  if (attempt.outcome === 'incomplete') return incompleteText(task.incomplete)
  return t('attempt.cancelled')
}

/**
 * «Last attempt» (fo1, B20): how the task's last attempt ended, why, when, and the one move that fits the reason —
 * Try again, Log in (the command to run), Show output (the saved file of a failed preparation or a red baseline),
 * Continue. The move is this block's button; Start stays available as the secondary action above.
 */
export function LastAttemptBlock({ task, attempt, pending, onRetry, onContinue }: { task: TaskSnapshot; attempt: Attempt; pending: boolean; onRetry(): void; onContinue(): void }) {
  const [output, setOutput] = useState(false)
  const [copied, setCopied] = useState<'login' | 'log' | null>(null)
  const move = attemptMove(attempt)
  const login = attempt.reason?.code === 'auth_expired' ? attempt.reason.login : undefined
  const hint = attempt.reason ? failureHint(attempt.reason) : undefined
  const copy = (text: string, what: 'login' | 'log') => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(what)).catch(() => {})
  }
  return (
    <section className="orc-overview-section orc-attempt" aria-label={t('attempt.title')}>
      <h3>{t('attempt.title')}</h3>
      <p className="orc-attempt__head">
        <strong>{t(`attempt.outcome.${attempt.outcome}`)}</strong>
        {' · '}
        <span>{reasonWords(attempt, task)}</span>
        {' · '}
        <time dateTime={attempt.at}>{new Date(attempt.at).toLocaleString()}</time>
      </p>
      {attempt.text && move !== 'show_output' ? <p className="orc-meta">{t('attempt.words', { text: attempt.text })}</p> : null}
      {hint ? <p className="orc-hint">{hint}</p> : null}
      <div className="orc-actions">
        {move === 'retry' ? <button type="button" className="orc-btn" disabled={pending} onClick={onRetry}>{t('attempt.retry')}</button> : null}
        {move === 'continue' ? <button type="button" className="orc-btn" disabled={pending} onClick={onContinue}>{t('panel.task.continue')}</button> : null}
        {move === 'login' && login ? <button type="button" className="orc-btn" onClick={() => copy(login, 'login')}>{t('attempt.login')}</button> : null}
        {move === 'show_output' ? <button type="button" className="orc-btn" aria-expanded={output} onClick={() => setOutput(!output)}>{t(output ? 'attempt.hideOutput' : 'attempt.showOutput')}</button> : null}
        {move === 'login' ? <button type="button" className="orc-btn orc-btn--ghost" disabled={pending} onClick={onRetry}>{t('attempt.retry')}</button> : null}
        {/* The command goes on a line of its own under both buttons (bx1). */}
        {move === 'login' && login ? <code>{login}</code> : null}
      </div>
      {copied === 'login' ? <p className="orc-hint" role="status">{t('attempt.loginCopied')}</p> : null}
      {move === 'show_output' && output ? <div className="orc-attempt__output">
        {attempt.text ? <pre className="orc-merge__commands">{attempt.text}</pre> : null}
        {attempt.log ? <p className="orc-meta">{t('attempt.outputFile')}: <code title={attempt.log}>{attempt.log}</code> <button type="button" className="orc-run__link" aria-label={t('attempt.copyOutputPath')} onClick={() => copy(attempt.log ?? '', 'log')}>{copied === 'log' ? '✓' : '⧉'}</button></p> : null}
      </div> : null}
    </section>
  )
}
