import { type KeyboardEvent, type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import type { RepoSnapshot } from '../shared/types.js'
import { t } from './i18n.js'
import { type LaneCounts, type LaneGroups, type LaneRow, historyByRecency, laneTree, readLaneGroups, readLaneGroupsForMount, writeLaneGroups } from './lane-tree.js'
import { laneOf, laneTitle } from './views/graph/layout.js'

/**
 * The third level of the sidebar tree, under the open plan: its lanes, live first. «Now» holds every
 * lane with an open task and starts open; «History» holds the finished ones and always starts folded.
 * «Now»'s open state is remembered per plan; «History» is opened by the reader for the current visit
 * only. Rows speak the sidebar's tree language (`data-srow`, `data-parent`, `data-children`), so the
 * rail's arrow keys walk them with the rest; the two group rows fold and unfold themselves on ←/→.
 */

/** «History» opens on the four most recently completed lanes; each «Show more» adds four more. */
export const HISTORY_SHOWN = 4

const COUNT_MARKS: ReadonlyArray<readonly [keyof LaneCounts, string]> = [
  ['running', '●'],
  ['checking', '◌'],
  ['review', '◐'],
  ['ready', '○'],
  ['queued', '·'],
  ['accepted', '✓'],
]

type LaneRepo = Pick<RepoSnapshot, 'root' | 'planId' | 'tasks'>

const laneName = (lane: string): string => laneTitle(lane) || t('side.lanes.noLane')

/** The counts spelled out for the tooltip and the screen reader. */
export const laneCountsLabel = (counts: LaneCounts): string =>
  COUNT_MARKS.filter(([key]) => counts[key] > 0).map(([key]) => t(`side.lanes.count.${key}`, { count: counts[key] })).join(' · ')

export function PlanLanes(props: {
  repo: LaneRepo
  /** The plan row's tree key: ← on a group row steps back to it. */
  parentKey: string
  /** The lane the graph looks at (or the lane Work and Review filter to). */
  highlight: string | null
  /** The selected task: going to a live one opens «Now»; a finished one never unfolds «History». */
  selected?: string | null
  onPick(lane: string): void
  onMenu(event: MouseEvent<HTMLElement>, lane: string): void
}) {
  const { repo, parentKey, highlight } = props
  const tree = useMemo(() => laneTree(repo), [repo])
  // «History» in display order only; the canonical order stays in `tree.history`.
  const history = useMemo(() => historyByRecency(repo, tree.history), [repo, tree])
  const [groups, setGroups] = useState<LaneGroups>(() => readLaneGroupsForMount(repo.root, repo.planId))
  const [historyLimit, setHistoryLimit] = useState(HISTORY_SHOWN)
  // A fold the reader made by hand in this visit wins over a later selection.
  const foldedByHand = useRef(new Set<keyof LaneGroups>())
  useEffect(() => {
    setGroups(readLaneGroupsForMount(repo.root, repo.planId))
    setHistoryLimit(HISTORY_SHOWN)
    foldedByHand.current = new Set()
  }, [repo.root, repo.planId])
  const toggle = (group: keyof LaneGroups, open = !groups[group]) => {
    const next = { ...groups, [group]: open }
    foldedByHand.current.add(group)
    setGroups(next)
    writeLaneGroups(repo.root, repo.planId, next)
    // Every fresh opening starts from the four most recent lanes.
    if (group === 'history' && !open) setHistoryLimit(HISTORY_SHOWN)
  }
  // Only a new selection opens «Now»: folding it by hand keeps the task selected. «History» is never
  // unfolded for a selection, and never reveals its tail — its open state is the reader's own.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selection alone drives this reveal.
  useEffect(() => {
    const task = props.selected ? repo.tasks.find((item) => item.id === props.selected) : undefined
    if (!task) return
    const lane = laneOf(task)
    if (tree.history.some((row) => row.lane === lane)) return
    if (foldedByHand.current.has('now')) return
    // Read from storage, not state: on a plan switch the state still holds the previous plan's groups.
    if (readLaneGroups(repo.root, repo.planId).now) return
    // Only «Now» changes: a stored legacy `history: true` must never ride into this visit's state.
    setGroups((current) => ({ ...current, now: true }))
  }, [props.selected, repo.root, repo.planId])
  const scope = `${repo.root}/${repo.planId ?? ''}`
  const groupKey = (group: keyof LaneGroups) => `lanes:${group}:${scope}`
  const rowKey = (lane: string) => `lane:${scope}:${lane}`

  const onGroupKeys = (event: KeyboardEvent<HTMLButtonElement>, group: keyof LaneGroups, rows: LaneRow[]) => {
    const open = groups[group]
    if (event.key === 'ArrowRight' && !open && rows.length > 0) toggle(group, true)
    else if (event.key === 'ArrowLeft' && open) toggle(group, false)
    else return
    // The fold is this row's own: the rail's handler must not step to the parent on the same key.
    event.preventDefault()
    event.stopPropagation()
  }

  const laneRow = (row: LaneRow, parent: string) => {
    const counts = laneCountsLabel(row.counts)
    const name = laneName(row.lane)
    const inView = highlight === row.lane
    return (
      <li key={row.lane} role="none">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: The row's context menu opens on the wrapper so the ⋯ button stays small. */}<div className="orc-srow" onContextMenu={(event) => props.onMenu(event, row.lane)}>
          <button
            type="button"
            role="treeitem"
            aria-selected={inView}
            aria-label={counts ? `${name} · ${counts}` : name}
            title={counts ? `${name}\n${counts}` : name}
            data-srow
            data-skey={rowKey(row.lane)}
            data-parent={parent}
            data-lane={row.lane}
            className={`orc-srow__main orc-srow__main--lane${row.finished ? ' orc-srow__main--past' : ''}${inView ? ' orc-srow__main--inview' : ''}`}
            onClick={() => props.onPick(row.lane)}
          >
            {row.finished ? <span className="orc-lanedot" aria-hidden="true" /> : <i className={`orc-lanedot orc-lanedot--${row.tone}`} aria-hidden="true" />}
            <span className="orc-srow__name">{name}</span>
            <span className="orc-lanecounts" aria-hidden="true">
              {row.finished
                ? <span className="orc-lanecount orc-lanecount--accepted">✓{row.counts.accepted}</span>
                : COUNT_MARKS.filter(([key]) => row.counts[key] > 0).map(([key, mark]) => (
                  <span key={key} className={`orc-lanecount orc-lanecount--${key}`}>{mark}{row.counts[key]}</span>
                ))}
            </span>
          </button>
          <button type="button" className="orc-srow__menu" aria-label={t('side.lanes.actions', { lane: name })} aria-haspopup="menu" onClick={(event) => props.onMenu(event, row.lane)}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3.6" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.4" cy="8" r="1.25" /></svg>
          </button>
        </div>
      </li>
    )
  }

  const group = (key: keyof LaneGroups, label: string, rows: LaneRow[]) => {
    if (rows.length === 0) return null
    const open = groups[key]
    const shown = key === 'history' ? rows.slice(0, historyLimit) : rows
    const hidden = rows.length - shown.length
    return (
      <li role="none">
        <button
          type="button"
          role="treeitem"
          aria-expanded={open}
          data-srow
          data-skey={groupKey(key)}
          data-parent={parentKey}
          data-children={open && shown[0] ? rowKey(shown[0].lane) : undefined}
          className={`orc-srow__main orc-srow__lanegroup${key === 'history' ? ' orc-srow__lanegroup--past' : ''}`}
          onClick={() => toggle(key)}
          onKeyDown={(event) => onGroupKeys(event, key, rows)}
        >
          <span className={`orc-lanegroup__arrow${open ? ' orc-lanegroup__arrow--open' : ''}`} aria-hidden="true">▶</span>
          <span className="orc-srow__name">{label}</span>
        </button>
        {open ? (
          // biome-ignore lint/a11y/useSemanticElements: A tree's nested level is an ARIA group, not a form fieldset.
          <ul className="orc-lanes" role="group">
            {shown.map((row) => laneRow(row, groupKey(key)))}
            {hidden > 0 ? (
              <li role="none">
                <button type="button" data-srow data-skey={`lanes:more:${scope}`} data-parent={groupKey(key)} className="orc-srow__main orc-srow__main--lane orc-srow__main--past" onClick={() => setHistoryLimit((limit) => limit + HISTORY_SHOWN)}>
                  <span className="orc-srow__name">{t('side.lanes.more', { count: Math.min(HISTORY_SHOWN, hidden) })}</span>
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
      </li>
    )
  }

  if (tree.now.length + tree.history.length === 0) return null
  return (
    // biome-ignore lint/a11y/useSemanticElements: A tree's nested level is an ARIA group, not a form fieldset.
    <ul className="orc-srow__kids orc-lanetree" role="group" aria-label={t('side.lanes.aria')}>
      {group('now', t('side.lanes.now', { count: tree.now.length }), tree.now)}
      {group('history', t('side.lanes.history', { count: history.length }), history)}
    </ul>
  )
}

/** The first row a plan row's → steps to: the «Now» group, or «History» when nothing is live. */
export function firstLaneGroupKey(repo: LaneRepo): string | undefined {
  const tree = laneTree(repo)
  const scope = `${repo.root}/${repo.planId ?? ''}`
  if (tree.now.length) return `lanes:now:${scope}`
  if (tree.history.length) return `lanes:history:${scope}`
  return undefined
}
