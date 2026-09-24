import { useEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from 'react'
import type { LedgerRecord, RepoSnapshot, Trajectory, WorkerInfo } from '../../shared/types.js'
import { clockLabel, money, tokensLabel } from '../insight.js'
import { api } from '../api.js'
import { orchestraStore } from '../store.js'
import { formatRoute, parseRoute } from '../route.js'
import { t, useLang } from '../i18n.js'
import { offset, } from './trace-steps.js'
import type { TraceTarget } from './trace.js'
import { kindCode as markCode, kindColor as color } from './trace-kinds.js'

const kinds = ['request', 'model', 'tool', 'edit', 'check', 'steer', 'problem', 'final'] as const
const lane = (kind: LedgerRecord['kind']) => kind === 'request' || kind === 'steer' ? 0 : kind === 'model' || kind === 'final' ? 1 : kind === 'problem' ? 3 : 2
const duration = (value: number | null) => value === null ? '—' : value < 1000 ? `${value} ms` : clockLabel(value)
const durationText = (record: LedgerRecord) => record.timing === 'open' ? t('panel.ledger.open') : `${record.timing === 'approximate' ? '~' : ''}${duration(record.durationMs)}`
const tokenText = (record: LedgerRecord) => record.tokens ? `${record.tokens.input} / ${record.tokens.output} / ${record.tokens.cacheRead}` : '—'
const rowHeight = 42
const ledgerKey = (repo: RepoSnapshot, runId: string) => `orc-ledger:${repo.root}:${repo.planId ?? ''}:${runId}`
const remembered = (key: string): { selected: number | null; scrollTop: number } => {
  try { const value = JSON.parse(sessionStorage.getItem(key) ?? '{}'); return { selected: typeof value.selected === 'number' ? value.selected : null, scrollTop: typeof value.scrollTop === 'number' ? value.scrollTop : 0 } } catch { return { selected: null, scrollTop: 0 } }
}


export function LedgerView({ trace, repo, target, workers, onSteerFrom, actions, seek }: {
  trace: Trajectory; repo: RepoSnapshot; target: TraceTarget; workers?: readonly WorkerInfo[]; onSteerFrom?(prefill: string): void
  actions(record: LedgerRecord): ReactNode
  /** An outside overview (the Review strip) asks for a step; `seq` repeats the same step on a second click. */
  seek?: { stepId: string; seq: number }
}) {
  useLang()
  const [records, setRecords] = useState(trace.records ?? [])
  const [nextCursor, setNextCursor] = useState(trace.nextCursor ?? null)
  const [loading, setLoading] = useState(false)
  const [pageError, setPageError] = useState(false)
  const hydrating = useRef(false)
  const focusStep = useRef<string | null>(null)
  const marks = trace.overviewMarks ?? records
  useEffect(() => {
    if (!trace.nextCursor) { setRecords(trace.records ?? []); setNextCursor(null) }
    else setRecords((old) => [...old.filter((item) => !trace.records?.some((current) => current.stepId === item.stepId)), ...(trace.records ?? [])].sort((a, b) => a.index - b.index))
  }, [trace])
  const loadPage = async (request: { cursor?: string; seek?: string }) => {
    setLoading(true); setPageError(false)
    try {
      const result = await api.trace(repo.root, target.taskId, target.run.runId, request)
      if (!result.ok) { setPageError(true); return }
      setRecords((old) => request.seek ? [...old.filter((item) => !result.value.records?.some((found) => found.stepId === item.stepId)), ...(result.value.records ?? [])].sort((a, b) => a.index - b.index) : [...old, ...(result.value.records ?? []).filter((item) => !old.some((found) => found.stepId === item.stepId))])
      if (!request.seek) setNextCursor(result.value.nextCursor ?? null)
      return result.value.records?.[0]
    } catch { setPageError(true) } finally { setLoading(false) }
  }
  const loadForSearch = async () => {
    if (hydrating.current || !nextCursor) return
    hydrating.current = true
    setLoading(true); setPageError(false)
    let cursor: string | null = nextCursor
    try {
      while (cursor) {
        const result = await api.trace(repo.root, target.taskId, target.run.runId, { cursor })
        if (!result.ok) { setPageError(true); break }
        setRecords((old) => [...old, ...(result.value.records ?? []).filter((item) => !old.some((found) => found.stepId === item.stepId))])
        cursor = result.value.nextCursor ?? null
        setNextCursor(cursor)
      }
    } catch { setPageError(true) } finally { hydrating.current = false; setLoading(false) }
  }
  const persistenceKey = ledgerKey(repo, target.run.runId)
  const [selected, setSelected] = useState<number | null>(() => remembered(persistenceKey).selected)
  const [query, setQuery] = useState('')
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(kinds))
  const [focus, setFocus] = useState<[number, number] | null>(null)
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const [rangeStart, setRangeStart] = useState<number | null>(null)
  const [scrollTop, setScrollTop] = useState(() => remembered(persistenceKey).scrollTop)
  const [height, setHeight] = useState(500)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => { if (list.current) list.current.scrollTop = scrollTop }, [scrollTop])
  useEffect(() => { try { sessionStorage.setItem(persistenceKey, JSON.stringify({ selected, scrollTop })) } catch { /* optional browser storage */ } }, [persistenceKey, selected, scrollTop])
  const chart = useRef<HTMLDivElement>(null)
  // Only a live run follows its newest step; a finished one opens at its first step or where the person left it.
  const following = useRef(target.run.active === true)
  const start = zoom?.[0] ?? trace.start
  const end = zoom?.[1] ?? trace.end
  const domain = Math.max(1, end - start)
  const visible = useMemo(() => records.filter((record) => enabled.has(record.kind) && (!query || `${record.label} ${record.input ?? ''} ${record.output ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (!focus || (record.startedAt <= focus[1] && record.startedAt + (record.durationMs ?? 0) >= focus[0]))), [records, enabled, query, focus])
  const selectedRecord = records.find((record) => record.index === selected)
  const selectedMark = marks.find((mark) => mark.index === selected)
  const zoomBy = (factor: number) => {
    const width = Math.min(Math.max(100, domain * factor), Math.max(100, trace.end - trace.start))
    const center = selectedMark?.startedAt ?? start + domain / 2
    const left = Math.max(trace.start, Math.min(trace.end - width, center - width / 2))
    setZoom(width >= trace.end - trace.start ? null : [left, left + width])
  }
  const selectStep = async (stepId: string) => {
    const record = records.find((item) => item.stepId === stepId) ?? await loadPage({ seek: stepId })
    if (!record) return
    if (query) setQuery('')
    if (!enabled.has(record.kind)) setEnabled(new Set(kinds))
    if (focus) setFocus(null)
    if (zoom && (record.startedAt < zoom[0] || record.startedAt > zoom[1])) setZoom(null)
    setSelected(record.index)
    focusStep.current = stepId
    orchestraStore.navigate({ task: target.taskId, run: target.run.runId, step: record.stepId }, 'replace')
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Initial deep link is handled once per ledger mount.
  useEffect(() => {
    const step = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('step')
    if (step) void selectStep(step)
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new request seeks; the step selection itself is not a dependency.
  useEffect(() => { if (seek) void selectStep(seek.stepId) }, [seek?.seq])
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 8)
  const last = Math.min(visible.length, Math.ceil((scrollTop + height) / rowHeight) + 8)
  const range = visible.slice(first, last)
  useEffect(() => {
    const stepId = focusStep.current
    if (!stepId || !list.current || selectedRecord?.stepId !== stepId) return
    const position = visible.findIndex((item) => item.stepId === stepId)
    if (position < 0) return
    list.current.scrollTop = Math.max(0, position * rowHeight - 100)
    setScrollTop(list.current.scrollTop)
    requestAnimationFrame(() => {
      if (focusStep.current !== stepId) return
      list.current?.querySelector<HTMLButtonElement>(`[data-step-id="${CSS.escape(stepId)}"]`)?.focus()
      focusStep.current = null
    })
  }, [selectedRecord, visible])
  const xToTime = (x: number) => start + Math.max(0, Math.min(1, x / Math.max(1, chart.current?.clientWidth ?? 1))) * domain
  const pointerX = (clientX: number) => clientX - (chart.current?.getBoundingClientRect().left ?? 0)
  useEffect(() => {
    if (!list.current) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => setHeight(list.current?.clientHeight ?? 500))
    observer.observe(list.current)
    return () => observer.disconnect()
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { if (following.current && list.current) { list.current.scrollTop = list.current.scrollHeight; setScrollTop(list.current.scrollTop) } }, [records.length, visible.length])
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const factor = event.deltaY > 0 ? 1.3 : 1 / 1.3
    const center = xToTime(pointerX(event.clientX))
    const width = Math.min(Math.max(100, domain * factor), Math.max(100, trace.end - trace.start))
    const left = Math.max(trace.start, Math.min(trace.end - width, center - width / 2))
    setZoom(width >= trace.end - trace.start ? null : [left, left + width])
  }
  const toggle = (kind: string) => setEnabled((old) => { const next = new Set(old); if (next.has(kind)) next.delete(kind); else next.add(kind); return next })
  const copy = () => { if (selectedRecord) void navigator.clipboard?.writeText([selectedRecord.input, selectedRecord.output].filter(Boolean).join('\n\n')) }
  const contexts = records.filter((record) => record.contextUsed !== undefined)
  const tokenPoints = records.filter((record) => record.tokens).reduce<Array<{ at: number; total: number }>>((points, record) => {
    points.push({ at: record.startedAt, total: (points.at(-1)?.total ?? 0) + (record.tokens?.input ?? 0) + (record.tokens?.output ?? 0) })
    return points
  }, [])
  const costPoints = records.filter((record) => record.costUsd !== undefined).reduce<Array<{ at: number; total: number }>>((points, record) => {
    points.push({ at: record.startedAt, total: (points.at(-1)?.total ?? 0) + (record.costUsd ?? 0) })
    return points
  }, [])
  return /* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper handles delegated pointer or keyboard events for its child controls. */ <div className="orc-ledger" onKeyDown={(event) => { if (event.key === 'Escape' && selected !== null) { event.preventDefault(); event.stopPropagation(); setSelected(null) } }}>
    {trace.synthetic ? <p className="orc-synthetic" role="note">{t('welcome.syntheticData')}</p> : null}
    {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */} <div className="orc-ledger__totals" aria-label={t('panel.ledger.totals')}>
      <span><b>{t('panel.ledger.duration')}</b>{trace.cost?.durationSec !== undefined ? clockLabel(trace.cost.durationSec * 1000) : target.run.active ? '—' : clockLabel(trace.totals.durationMs)}</span>
      <span><b>{t('panel.ledger.tokens')}</b>{trace.cost?.tokens ? tokensLabel(trace.cost.tokens) : '—'}</span>
      <span><b>{t('panel.ledger.money')}</b>{trace.cost?.cashUsd ? money(trace.cost.cashUsd.value) : trace.cost?.apiEquivalentUsd ? `${money(trace.cost.apiEquivalentUsd.value)} · ${t('review.notCharged')}` : trace.cost?.quotaDeltaPct !== undefined ? `${trace.cost.quotaDeltaPct.toFixed(1)} ${t('review.pp')}` : '—'}</span>
      <span><b>{t('panel.ledger.wait')}</b>{trace.humanWaitMs !== undefined ? clockLabel(trace.humanWaitMs) : '—'}</span>
      <span><b>{t('panel.ledger.outcome')}</b>{t(`panel.ledger.outcome.${trace.outcome ?? 'running'}`)} · {trace.reviewOutcome ? t(`panel.ledger.outcome.${trace.reviewOutcome}`) : t('review.noDecision')}</span>
    </div>
    <div className="orc-ledger__overview">
      <div className="orc-ledger__overview-head"><strong>{t('panel.ledger.overview')}</strong><span>{offset(start, trace.start)} – {offset(end, trace.start)}</span><button type="button" className="orc-more" onClick={() => { setFocus(null); setZoom(null); setRangeStart(null) }}>{t('panel.ledger.clear')}</button></div>
      <p className="orc-meta" role="status">{t('panel.ledger.summary', { total: trace.totalSteps ?? records.length, from: trace.retainedRange?.from ?? (records.length ? 1 : 0), to: trace.retainedRange?.to ?? records.length })} · {t(`panel.ledger.completeness.${trace.completeness ?? 'complete'}`)} · {t('panel.ledger.approximate', { count: marks.filter((mark) => mark.timing === 'approximate').length })} · {(['model', 'tool', 'edit', 'check', 'problem', 'steer', 'request'] as const).map((kind) => `${markCode(kind)} ${t(`panel.ledger.kind.${kind}`)} ${marks.filter((mark) => kind === 'model' ? mark.kind === 'model' || mark.kind === 'final' : kind === 'problem' ? mark.kind === 'problem' || ('isError' in mark && !!mark.isError) : mark.kind === kind).length}`).join(' · ')}</p>
      <div className="orc-ledger__overview-tools"><button type="button" className="orc-btn orc-btn--ghost" onClick={() => zoomBy(1 / 1.5)}>{t('panel.ledger.zoomIn')}</button><button type="button" className="orc-btn orc-btn--ghost" onClick={() => zoomBy(1.5)}>{t('panel.ledger.zoomOut')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={!selectedMark} onClick={() => setRangeStart(selectedMark?.startedAt ?? null)}>{t('panel.ledger.rangeStart')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={!selectedMark || rangeStart === null} onClick={() => { if (selectedMark && rangeStart !== null) setFocus([Math.min(rangeStart, selectedMark.startedAt), Math.max(rangeStart, selectedMark.startedAt + (selectedMark.durationMs ?? 0))]) }}>{t('panel.ledger.rangeEnd')}</button></div>
      <div ref={chart} className="orc-ledger__chart" role="slider" tabIndex={0} aria-valuemin={1} aria-valuemax={Math.max(1, marks.length)} aria-valuenow={selected ?? 1} aria-label={t('panel.ledger.timeline')} onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft' && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const current = marks.findIndex((item) => item.index === selected)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1 : Math.max(0, Math.min(marks.length - 1, current + (event.key === 'ArrowRight' ? 1 : -1)))
        const mark = marks[index]
        if (mark) void selectStep(mark.stepId)
      }} onWheel={onWheel} onContextMenu={(event) => { event.preventDefault(); setFocus(null) }} onPointerDown={(event) => { if (event.button === 0) { setDrag(xToTime(pointerX(event.clientX))); event.currentTarget.setPointerCapture(event.pointerId) } }} onPointerUp={(event) => { if (drag !== null) { const to = xToTime(pointerX(event.clientX)); setFocus([Math.min(drag, to), Math.max(drag, to)]); setDrag(null) } }}>
        {trace.turns.map((turn) => turn.start >= start && turn.start <= end ? <i key={turn.index} className="orc-ledger__turnmark" style={{ left: `${((turn.start - start) / domain) * 100}%` }} title={t('panel.ledger.turn', { n: turn.index })} /> : null)}
        {marks.map((record) => { const left = Math.max(start, record.startedAt); const right = Math.min(end, record.startedAt + (record.durationMs ?? 0)); if (left > end || right < start) return null; return <button key={record.stepId} type="button" tabIndex={-1} aria-label={`${t(`panel.ledger.kind.${record.kind}`)} #${record.index}`} aria-current={selected === record.index ? "step" : undefined} className={`orc-ledger__span${record.durationMs === null || record.durationMs === 0 ? ' orc-ledger__span--mark' : ''}`} style={{ left: `${((left - start) / domain) * 100}%`, width: record.durationMs ? `${Math.max(.25, ((right - left) / domain) * 100)}%` : undefined, top: `${8 + lane(record.kind) * 19}px`, background: color(record.kind) }} title={`#${record.index}`} onPointerDown={(event) => event.stopPropagation()} onClick={() => { void selectStep(record.stepId) }} /> })}
        {selectedRecord ? <div className="orc-ledger__selection" style={{ left: `${((selectedRecord.startedAt - start) / domain) * 100}%`, width: `${Math.max(.5, ((selectedRecord.durationMs ?? 0) / domain) * 100)}%` }} /> : null}
        {focus ? <div className="orc-ledger__focus" style={{ left: `${((focus[0] - start) / domain) * 100}%`, width: `${((focus[1] - focus[0]) / domain) * 100}%` }} /> : null}
      </div>
      {tokenPoints.length > 1 ? <svg className="orc-ledger__usage" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={t('panel.ledger.cumulativeTokens')}><polyline fill="none" stroke="var(--orc-ok)" strokeWidth="1.5" points={tokenPoints.map((point) => `${((point.at - trace.start) / Math.max(1, trace.end - trace.start)) * 100},${30 - point.total / Math.max(tokenPoints.at(-1)?.total ?? 1, 1) * 27}`).join(' ')} /></svg> : contexts.length > 1 ? <svg className="orc-ledger__usage" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={t('panel.ledger.contextLine')}><polyline fill="none" stroke="var(--orc-ok)" strokeWidth="1.5" points={contexts.map((record) => `${((record.startedAt - trace.start) / Math.max(1, trace.end - trace.start)) * 100},${30 - (record.contextUsed ?? 0) / Math.max(...contexts.map((item) => item.contextUsed ?? 0), 1) * 27}`).join(' ')} /></svg> : null}
      {costPoints.length > 1 ? <svg className="orc-ledger__usage" viewBox="0 0 100 32" preserveAspectRatio="none" aria-label={t('panel.ledger.cumulativeCost')}><polyline fill="none" stroke="var(--orc-warn)" strokeWidth="1.5" points={costPoints.map((point) => `${((point.at - trace.start) / Math.max(1, trace.end - trace.start)) * 100},${30 - point.total / Math.max(costPoints.at(-1)?.total ?? 1, .000001) * 27}`).join(' ')} /></svg> : null}
    </div>
    <div className="orc-ledger__controls"><input className="orc-field" type="search" aria-label={t('panel.ledger.search')} placeholder={t('panel.ledger.search')} value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value) void loadForSearch() }} />{kinds.map((kind) => <button type="button" key={kind} className="orc-ledger__filter" aria-pressed={enabled.has(kind)} onClick={() => { toggle(kind); void loadForSearch() }}>{t(`panel.ledger.kind.${kind}`)}</button>)}<span role="status">{t('panel.ledger.matches', { count: visible.length })}{loading ? ` · ${t('panel.ledger.searching')}` : ''}</span></div>
    <div className="orc-ledger__paging"><span>{t('panel.ledger.loaded', { count: records.length, total: trace.totalSteps ?? records.length })}</span><button type="button" className="orc-btn orc-btn--ghost" disabled={!nextCursor || loading} onClick={() => { if (nextCursor) void loadPage({ cursor: nextCursor }) }}>{t('panel.ledger.more')}</button><button type="button" className="orc-btn orc-btn--ghost" disabled={!marks.length} onClick={() => { const last = marks.at(-1); if (last) void selectStep(last.stepId) }}>{t('panel.ledger.latest')}</button>{pageError ? <span role="alert">{t('panel.ledger.loadError')}</span> : null}</div>
    <div className="orc-ledger__body">{/* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */} <div ref={list} className="orc-ledger__list" onScroll={(event) => { const node = event.currentTarget; setScrollTop(node.scrollTop); following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80 }} role="list" aria-label={t('panel.ledger.records')}>
      <div style={{ height: visible.length * rowHeight, position: 'relative' }}>{range.map((record, offsetIndex) => <div key={record.stepId} className="orc-ledger__item" style={{ top: (first + offsetIndex) * rowHeight }} role="listitem"><button type="button" className="orc-ledger__row" data-step-id={record.stepId} aria-pressed={selected === record.index} onClick={() => { void selectStep(record.stepId) }}><span className="orc-ledger__number">#{record.index}</span><span className="orc-ledger__icon" style={{ color: color(record.kind) }}>{markCode(record.kind)}</span><span className="orc-ledger__label">{record.turn !== visible[first + offsetIndex - 1]?.turn ? <em>{t('panel.ledger.turn', { n: record.turn })} · </em> : null}{record.label}{record.isError ? ` · ${t('panel.ledger.kind.problem')}` : ''}</span><span className="orc-ledger__duration">{durationText(record)}</span><span className="orc-ledger__tokens">{tokenText(record)}</span></button></div>)}</div>
    </div><aside className="orc-ledger__inspector" aria-label={t('panel.ledger.inspector')}>{selectedRecord ? <><div className="orc-tr__ihead"><h3 className="orc-tr__it">#{selectedRecord.index} {selectedRecord.label}</h3><button className="orc-more" type="button" onClick={copy}>{t('panel.ledger.copy')}</button></div><a href={formatRoute({ ...(parseRoute(window.location.hash) ?? { repo: repo.root, plan: repo.planId ?? '_', view: 'review' }), view: 'review', task: target.taskId, tab: 'review-run', run: target.run.runId, step: selectedRecord.stepId })}>{t('panel.ledger.stepLink')}</a><p className="orc-meta">{t(`panel.ledger.kind.${selectedRecord.kind}`)} · {new Date(selectedRecord.startedAt).toLocaleString()} · {durationText(selectedRecord)} · {t('panel.ledger.turn', { n: selectedRecord.turn })}</p><p className="orc-meta">{t('panel.ledger.tokens')}: {tokenText(selectedRecord)}{selectedRecord.contextUsed !== undefined ? ` · ${t('panel.ledger.context')}: ${selectedRecord.contextUsed}` : ''}{selectedRecord.costUsd !== undefined ? ` · ${money(selectedRecord.costUsd)}` : ''}</p>{selectedRecord.state ? <p className="orc-meta">{t('panel.ledger.state')}: {selectedRecord.state}</p> : null}<h4>{t('panel.ledger.input')}</h4><BoundedOutput key={`${selectedRecord.stepId}:input`} value={selectedRecord.input} /><h4>{t('panel.ledger.output')}</h4><BoundedOutput key={`${selectedRecord.stepId}:output`} value={selectedRecord.output} />{actions(selectedRecord)}</> : <p className="orc-meta">{t('panel.ledger.select')}</p>}</aside></div>
  </div>
}

function BoundedOutput({ value }: { value?: string }) {
  const [expanded, setExpanded] = useState(false)
  const text = value ?? '—'
  return <><pre>{expanded ? text : text.slice(0, 4000)}</pre>{text.length > 4000 ? <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setExpanded(true)} disabled={expanded}>{t('panel.ledger.loadOutput', { size: text.length })}</button> : null}</>
}
