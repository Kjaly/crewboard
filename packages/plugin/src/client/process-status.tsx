import type { OrchestraRepoSnapshot, TaskSnapshot } from '../shared/types.js'
import { t, useLang } from './i18n.js'
import { LensChip } from './lens-chips.js'
import type { Lens } from './lens.js'

type Stage = 'running' | 'check' | 'close'
const planChatAwake = (repo: OrchestraRepoSnapshot): boolean => repo.plans?.find((plan) => plan.id === repo.planId || (!repo.planId && plan.current))?.chat?.wake === true

/** The chat owns a routine positive result until it closes it or reports an exception. */
export function orchestratorClosing(repo: OrchestraRepoSnapshot, task: TaskSnapshot): boolean {
  return planChatAwake(repo) && task.status === 'in_review' && task.check === 'checked' && task.kind !== 'decision' && task.kind !== 'root'
    && task.verdict?.kind === 'result' && !task.verdict.caution && !task.conflicts?.length
}

/** A checked accepted branch can use the orchestrator's automatic merge path. */
export function orchestratorMerging(repo: OrchestraRepoSnapshot, task: TaskSnapshot): boolean {
  return planChatAwake(repo) && task.status === 'accepted' && !!task.unmerged && task.check === 'checked'
}

/** The visible stages are derived from real task states, so the strip never simulates progress. */
export function processStages(repo: OrchestraRepoSnapshot): Record<Stage, TaskSnapshot[]> {
  return {
    running: repo.tasks.filter((task) => task.status === 'running'),
    check: repo.tasks.filter((task) => task.status === 'in_review' && (task.check === 'pending' || task.check === 'checking')),
    close: repo.tasks.filter((task) => orchestratorMerging(repo, task) || orchestratorClosing(repo, task)),
  }
}

/** The strip hides for example, archived and partial repos; there the header keeps the running lens chip. */
export function processStripEligible(repo: OrchestraRepoSnapshot): boolean {
  return !(repo.example || repo.archived || repo.partial)
}

export function ProcessStatus({ repo, lens, onLens, onPick }: {
  repo: OrchestraRepoSnapshot
  lens: Lens | null
  onLens(lens: Lens | null): void
  onPick(id: string): void
}) {
  useLang()
  if (!processStripEligible(repo)) return null
  const stages = processStages(repo)
  if (!Object.values(stages).some((tasks) => tasks.length > 0)) return null
  return (
    <section className="orc-process" aria-label={t('process.title')}>
      <span className="orc-process__title">{t('process.title')}</span>
      {/* The running stage is the same lens chip as the header's: click toggles the lens and
          opens the list, a row flies to its task — it never jumps to the first task. */}
      {stages.running.length ? (
        <LensChip kind="running" stage moving count={stages.running.length} repo={repo} active={lens === 'running'} onLens={onLens} onPick={onPick} />
      ) : (
        <button type="button" className="orc-process__stage" disabled>
          <span className="orc-process__dot" aria-hidden="true" />
          <span>{t('process.running')}</span> <strong>0</strong>
        </button>
      )}
      {(['check', 'close'] as const).map((stage) => {
        const tasks = stages[stage]
        const moving = stage === 'check' && tasks.some((task) => task.check === 'checking')
        return <button key={stage} type="button" className={`orc-process__stage${tasks.length ? ' orc-process__stage--active' : ''}${tasks.length && moving ? ' orc-process__stage--moving' : ''}`} disabled={!tasks.length} title={tasks.map((task) => `${task.id} · ${task.title}`).join('\n') || undefined} onClick={() => tasks[0] && onPick(tasks[0].id)}>
          <span className="orc-process__dot" aria-hidden="true" />
          <span>{t(stage === 'check' && !moving ? 'process.checkPending' : `process.${stage}`)}</span> <strong>{tasks.length}</strong>
        </button>
      })}
      {stages.close.length ? <span className="orc-process__note">{t('process.closeHint')}</span> : null}
    </section>
  )
}
