import { useEffect, useState } from 'react'
import type { TaskDetail } from '../../shared/types.js'
import { checkPassed, requiredChecks } from '../../../../core/src/orchestration/verdict.js'
import { t } from '../i18n.js'

/**
 * The contract's checks as Crewboard ran them in the task's copy (ck1, B30): a fact of its own beside the worker's
 * claim — how many passed, each failure with its last lines and the file with the whole output — and the button
 * that runs them. Only the contract's `<checks>` run; a contract without them says so instead of a button.
 */
export function CrewboardChecks({ detail, canRun, pending, onRun }: { detail: TaskDetail; canRun: boolean; pending: boolean; onRun(): void }) {
  const ran = detail.evidence?.crewboardChecks
  const commands = detail.contract ? requiredChecks(detail.contract.text) : []
  const failed = ran?.checks.filter((check) => !checkPassed(check)) ?? []
  const [expanded, setExpanded] = useState(!ran || failed.length > 0)
  useEffect(() => setExpanded(!ran || failed.length > 0), [ran, failed.length])
  if (!ran && !(canRun && detail.evidence)) return null
  return (
    <section className="orc-overview-section orc-ckrun" aria-busy={pending}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="orc-ckrun__summary"><span>{t('panel.checks.title')}</span>{ran ? <strong className={`orc-ckrun__sum orc-ckrun__sum--${failed.length ? 'warn' : 'ok'}`}>{t('panel.checks.summary', { passed: ran.checks.length - failed.length, total: ran.checks.length })}</strong> : null}</summary>
      {ran ? <>
        <p className="orc-meta">{t('panel.checks.meta', { by: t(`panel.checks.by.${ran.by}`), when: new Date(ran.ranAt).toLocaleString() })}</p>
        {failed.length ? <ul className="orc-list orc-ckrun__failed">{failed.map((check) => (
          <li key={check.command}>
            <p><code>{check.command}</code> · {check.timedOut ? t('panel.checks.timeout', { seconds: ran.timeoutSec }) : t('panel.checks.exit', { code: check.exitCode })}</p>
            {check.tail ? <pre className="orc-ckrun__tail">{check.tail}</pre> : null}
            <p className="orc-meta" title={check.output}>{t('panel.checks.output', { path: check.output })}</p>
          </li>
        ))}</ul> : null}
      </> : <p className="orc-meta">{t('panel.checks.none')}</p>}
      {canRun ? commands.length
        ? <button type="button" className="orc-btn orc-btn--ghost" disabled={pending} onClick={onRun}>{pending ? t('panel.checks.running') : t(ran ? 'panel.checks.rerun' : 'panel.checks.run')}</button>
        : <p className="orc-meta">{t('panel.checks.noBlock')}</p> : null}
      </details>
    </section>
  )
}
