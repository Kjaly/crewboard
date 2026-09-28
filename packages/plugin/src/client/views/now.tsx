import type { OrchestraSnapshot } from '../../shared/types.js'
import { relativeTime, t, useLang } from '../i18n.js'
import { type NowRow, groupNowRows, nowCounts, nowModel, rowDetail } from '../now.js'

/**
 * The global «Now» screen: what is actually happening in every served, non-archived plan, at a glance.
 * It renders the host's own `snapshot.now` projection — no transcript, no scan, no model request — and
 * keeps the three blocks the brief asks for apart: a person's actionable moves, work in progress and
 * run alerts. A checked task is never called «merging now»; the stage word states only what is true.
 * Reachable from the rail and ⌘K, and addressed by `#orchestra/now` so reload and Back work.
 *
 * The project picker is the App's compact `ProjectSwitcher` above this screen: one canonical switcher
 * everywhere, so Now itself carries no second, unbounded project/copy block.
 */
export function NowView(props: {
  snapshot: OrchestraSnapshot
  onOpenRow(row: NowRow): void
  onClose(): void
}) {
  useLang()
  const { snapshot } = props
  const model = nowModel(snapshot, snapshot.order)
  const counts = nowCounts(model)
  const repoName = (root: string): string => snapshot.repos.find((repo) => repo.root === root)?.family?.name || snapshot.repos.find((repo) => repo.root === root)?.title || root.split('/').pop() || root
  const blocks: ReadonlyArray<{ key: 'human' | 'work' | 'alerts'; label: string; rows: NowRow[] }> = [
    { key: 'human', label: t('now.human'), rows: model.human },
    { key: 'work', label: t('now.work'), rows: model.work },
    { key: 'alerts', label: t('now.alerts'), rows: model.alerts },
  ]
  const age = (row: NowRow): string | null => {
    if (row.since) {
      const at = Date.parse(row.since)
      if (Number.isFinite(at)) return relativeTime(at)
    }
    return row.ageMin !== undefined ? t('now.ageMin', { count: row.ageMin }) : null
  }
  // The whole row is the control; its accessible name states the move instead of a standalone «Open» that wraps.
  const openLabel = (row: NowRow): string => `${t('now.open')}: ${row.title}`

  return (
    <section className="orc-now" aria-label={t('now.title')} data-now-screen>
      <header className="orc-now__head">
        <h1 className="orc-now__title">{t('now.title')}</h1>
        <span className="orc-now__hint">{t('now.hint')}</span>
        <span className="orc-now__spacer" />
        <button type="button" className="orc-chip" onClick={props.onClose}>{t('now.back')}</button>
      </header>

      {model.coverage !== 'known' ? (
        <div className="orc-now__coverage" role="status" data-now-coverage={model.coverage}>
          <strong>{t('now.coverage.title')}</strong>
          <span>{model.coverage === 'partial' ? t('now.coverage.partial') : t('now.coverage.unknown')}</span>
          {model.unknown.length > 0 ? (
            <ul className="orc-now__unknown">
              {model.unknown.map((item) => <li key={`${item.root}/${item.planId}`}>{repoName(item.root)} · {item.planId}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}

      {counts.human + counts.work + counts.alerts === 0 ? (
        <p className="orc-now__empty" data-now-empty>{t('now.empty')}</p>
      ) : null}

      {blocks.map((block) => (
        <section key={block.key} className={`orc-now__block orc-now__block--${block.key}`} aria-label={block.label} data-now-block={block.key}>
          <h2 className="orc-now__blockhead">
            {block.label} <strong>{block.rows.length}</strong>
          </h2>
          {block.rows.length === 0 ? (
            <p className="orc-now__calm">{t(`now.calm.${block.key}`)}</p>
          ) : (
            groupNowRows(block.rows).map((group) => (
              <div key={group.project} className="orc-now__group">
                {/* The canonical project is carried once by the group header, not repeated on every row. */}
                <h3 className="orc-now__grouphead">{group.project}</h3>
                <ul className="orc-now__list">
                  {group.rows.map((row) => {
                    const when = age(row)
                    return (
                      <li key={row.key}>
                        <button type="button" className={`orc-now__row orc-now__row--${row.stage}`} data-now-row={row.key} aria-label={openLabel(row)} title={openLabel(row)} onClick={() => props.onOpenRow(row)}>
                          <span className="orc-now__loc" title={`${row.root}/${row.planId}`}>{rowDetail(row)}</span>
                          <span className="orc-now__rowtitle">{row.title}</span>
                          <span className="orc-now__meta">
                            <span className={`orc-now__stage orc-now__stage--${row.stage}`}>{t(`now.stage.${row.stage}`)}</span>
                            {row.block === 'human' && row.decision ? <span className="orc-now__fact orc-now__fact--human">{t('now.fact.decision')}</span> : null}
                            {row.block === 'human' && !row.decision && row.humanReview === true ? <span className="orc-now__fact orc-now__fact--human">{t('now.fact.humanReview')}</span> : null}
                            {row.futureFact ? <span className="orc-now__fact">{t(`now.future.${row.futureFact}`)}</span> : null}
                            {row.alerts.length > 0 ? <span className="orc-now__fact orc-now__fact--alert">{row.alerts.join(', ')}</span> : null}
                            {row.worker ? <span className="orc-now__worker">{row.worker}</span> : null}
                            {when ? <span className="orc-now__age">{when}</span> : null}
                            <span className="orc-now__chevron" aria-hidden="true">›</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
      ))}
    </section>
  )
}
