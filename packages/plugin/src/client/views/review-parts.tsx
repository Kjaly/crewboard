import { useEffect, useRef, useState } from 'react'
import type { LedgerRecord, PlanRunCost, RunStepSummary } from '../../shared/types.js'
import { api } from '../api.js'
import { decodeStrip, type StripCell } from '../../../../core/src/runs/ledger-strip.js'
import { t } from '../i18n.js'
import { kindCode, kindColor, TRACE_KINDS } from '../panel/trace-kinds.js'
import type { RunStatus } from './review-index.js'

type Kind = LedgerRecord['kind']
const TONE: Record<RunStatus, string> = { running: 'run', waiting: 'warn', failed: 'error', accepted: 'ok', returned: 'idle', completed: 'idle', unknown: 'idle' }

/** Status colour always comes with its word: the dot alone never carries the meaning. */
export function StatusWord({ status, cancelled, incomplete }: { status: RunStatus; cancelled?: boolean; incomplete?: boolean }) {
  return (
    <span className={`orc-rstatus orc-rstatus--${TONE[status]}`}>
      <i aria-hidden="true" />
      {status === 'failed' && cancelled ? t('review.status.stopped') : status === 'failed' && incomplete ? t('drill.execution.incomplete') : t(`review.status.${status}`)}
    </span>
  )
}

const kindName = (kind: Kind) => t(`review.kind.${kind === 'final' ? 'model' : kind}`)
const countsLabel = (counts: Partial<Record<Kind, number>>) =>
  TRACE_KINDS.map((kind) => [kind, (counts[kind] ?? 0) + (kind === 'model' ? counts.final ?? 0 : 0)] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kindName(kind)} ${count}`)
    .join(', ')

const finishedSteps = new Map<string, RunStepSummary>()
/**
 * Strips for the rows on screen only: the plan summary stays free of raw events, and a finished
 * run's strip is fetched once. Live runs refresh with every new cost snapshot.
 */
export function useRunSteps(root: string, runs: PlanRunCost[], refresh: string) {
  const [fetched, setFetched] = useState<{ root: string; value: Record<string, RunStepSummary>; failed: string[] }>({ root, value: {}, failed: [] })
  const want = runs.filter((run) => !run.finishedAt || !finishedSteps.has(`${root}:${run.runId}`)).map((run) => run.runId)
  const key = want.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: The joined IDs and the snapshot stamp decide when to fetch.
  useEffect(() => {
    if (!want.length) return
    let live = true
    const fail = () => { if (live) setFetched((old) => ({ root, value: old.root === root ? old.value : {}, failed: want })) }
    void api.runSteps(root, want).then((result) => {
      if (!live) return
      if (!result.ok) { fail(); return }
      for (const [id, steps] of Object.entries(result.value)) if (steps.completeness !== 'live') finishedSteps.set(`${root}:${id}`, steps)
      setFetched((old) => ({ root, value: { ...(old.root === root ? old.value : {}), ...result.value }, failed: [] }))
    }).catch(fail)
    return () => { live = false }
  }, [root, key, refresh])
  return (runId: string): RunStepSummary | 'loading' | 'unavailable' =>
    finishedSteps.get(`${root}:${runId}`) ?? (fetched.root === root ? fetched.value[runId] : undefined) ?? (fetched.failed.includes(runId) ? 'unavailable' : 'loading')
}

/**
 * A run row's overview: the host's sampled strip of ledger kinds. Positions are elapsed time, not cost;
 * the note says how many steps it samples, whether the history is complete, and how many problems it holds.
 */
export function RowStrip({ steps }: { steps: RunStepSummary | 'loading' | 'unavailable' }) {
  if (steps === 'loading') return <span className="orc-strip orc-strip--pending" aria-hidden="true" />
  if (steps === 'unavailable' || steps.total === 0)
    return <span className="orc-strip__note">{steps === 'unavailable' ? t('review.steps.unavailable') : t(`review.steps.none.${steps.completeness}`)}</span>
  const cells = decodeStrip(steps.strip)
  return (
    <>
      <span className="orc-strip" role="img" aria-label={t('review.steps.aria', { counts: countsLabel(steps.counts) })}>
        {cells.map((kind, index) => (
          <i key={index} className={kind ? `orc-strip__cell orc-strip__cell--${kind}` : 'orc-strip__cell'} style={kind ? { background: kindColor(kind) } : undefined} />
        ))}
      </span>
      <span className="orc-strip__note">
        {t('review.steps.note', { count: steps.total })} · {t(`review.steps.${steps.completeness}`)} · {t(`review.steps.timing.${steps.timing}`)}
        {steps.problems ? <b className="orc-strip__problems"> · {t('review.steps.problems', { count: steps.problems })}</b> : null}
      </span>
    </>
  )
}

/**
 * The same strip in run detail, built from the ledger's own marks so each cell is a route to its
 * first step. Arrow keys move between cells; the ledger rows below remain the full keyboard path.
 */
export function DetailStrip({ cells, timing, onStep }: { cells: Array<StripCell | null>; timing: 'elapsed' | 'sequence'; onStep(stepId: string): void }) {
  const box = useRef<HTMLDivElement>(null)
  const live = cells.flatMap((cell, index) => (cell ? [index] : []))
  const move = (from: number, dir: number) => {
    const at = live.indexOf(from)
    const next = live[Math.max(0, Math.min(live.length - 1, at + dir))]
    box.current?.querySelector<HTMLButtonElement>(`[data-cell="${next}"]`)?.focus()
  }
  if (!live.length) return <p className="orc-strip__note">{t('review.steps.unavailable')}</p>
  return (
    <div className="orc-strip-detail">
      <div ref={box} className="orc-strip orc-strip--detail" role="toolbar" aria-label={t('review.steps.route')}>
        {cells.map((cell, index) =>
          cell ? (
            <button
              type="button"
              key={index}
              data-cell={index}
              tabIndex={index === live[0] ? 0 : -1}
              className={`orc-strip__cell orc-strip__cell--${cell.kind}`}
              style={{ background: kindColor(cell.kind) }}
              aria-label={t('review.steps.cell', { kind: kindName(cell.kind), count: cell.count, index: cell.index })}
              title={`${kindCode(cell.kind)} ${kindName(cell.kind)} · ${cell.count}`}
              onClick={() => onStep(cell.stepId)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
                event.preventDefault()
                move(index, event.key === 'ArrowRight' ? 1 : -1)
              }}
            />
          ) : (
            <i key={index} className="orc-strip__cell" />
          ),
        )}
      </div>
      <span className="orc-strip__note">{t(`review.steps.timing.${timing}`)}</span>
    </div>
  )
}

export function StripLegend() {
  return (
    <ul className="orc-strip-legend" aria-label={t('review.legend')}>
      {TRACE_KINDS.map((kind) => (
        <li key={kind}>
          <i aria-hidden="true" style={{ background: kindColor(kind) }} />
          <b>{kindCode(kind)}</b> {kindName(kind)}
        </li>
      ))}
    </ul>
  )
}
