import { useEffect, useMemo, useState } from 'react'
import type { Finding, PlanDraft } from '../../../core/src/plan/draft.js'
import { isBlocking } from './draft-findings.js'
import { api, type DraftDetail } from './api.js'
import { describeApiError } from './actions.js'
import { t, useLang } from './i18n.js'

function orderedTasks(draft: PlanDraft): PlanDraft['tasks'] {
  const byId = new Map(draft.tasks.map((task) => [task.id, task]))
  const seen = new Set<string>()
  const visiting = new Set<string>()
  const ordered: PlanDraft['tasks'] = []
  const visit = (id: string) => {
    if (seen.has(id) || visiting.has(id)) return
    const task = byId.get(id)
    if (!task) return
    visiting.add(id)
    task.deps.forEach(visit)
    visiting.delete(id)
    seen.add(id)
    ordered.push(task)
  }
  draft.tasks.forEach((task) => { visit(task.id) })
  return ordered
}

function findingTasks(finding: Finding): string[] {
  const ids = finding.data.tasks
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : typeof finding.data.task === 'string' ? [finding.data.task] : []
}

function FindingRow({ finding, known }: { finding: Finding; known: Set<string> }) {
  const ids = findingTasks(finding)
  const details: Record<string, string> = finding.code === 'missing_dependency' ? { task: ids[0] ?? '', dependency: String(finding.data.dependency ?? '') }
    : finding.code === 'file_collision' ? { file: String(finding.data.file ?? ''), tasks: ids.join(', ') }
    : { task: ids[0] ?? '', tasks: ids.join(' → ') }
  return <li className={isBlocking(finding) ? 'orc-draft__finding--block' : ''}>
    <span>{isBlocking(finding) ? t('panel.draft.blocksApproval') : t('panel.draft.advisory')}</span> {t(`panel.draft.finding.${finding.code}`, details)}
    {ids.some((id) => known.has(id)) ? <span className="orc-draft__links">{ids.filter((id) => known.has(id)).map((id) => <a key={id} href={`#draft-task-${id}`}>{id}</a>)}</span> : null}
  </li>
}

export function DraftReview({ repo, id, onApproved, onDiscarded, onClose }: { repo: string; id: string; onApproved(id: string): void; onDiscarded(id: string): void; onClose(): void }) {
  useLang()
  const [detail, setDetail] = useState<DraftDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  useEffect(() => {
    let live = true
    setDetail(null)
    setError(null)
    setConfirmDiscard(false)
    void api.planDraft(repo, id).then((result) => {
      if (!live) return
      if (result.ok) setDetail(result.value)
      else setError(describeApiError(result.error, result.message))
    }).catch(() => { if (live) setError(t('actions.noConnection')) })
    return () => { live = false }
  }, [repo, id])
  const groups = useMemo(() => {
    if (!detail) return []
    const ordered = orderedTasks(detail.draft)
    return detail.draft.lanes.map((lane) => ({ lane, tasks: ordered.filter((task) => task.lane === lane) })).filter((group) => group.tasks.length)
      .concat([...new Set(ordered.map((task) => task.lane))].filter((lane) => !detail.draft.lanes.includes(lane)).map((lane) => ({ lane, tasks: ordered.filter((task) => task.lane === lane) })))
  }, [detail])
  const blocking = detail?.findings.filter(isBlocking) ?? []
  const known = new Set(detail?.draft.tasks.map((task) => task.id) ?? [])
  const act = async (kind: 'approve' | 'discard') => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result = kind === 'approve' ? await api.planDraftApprove(repo, id) : await api.planDraftDiscard(repo, id)
      if (!result.ok) { setError(describeApiError(result.error, result.message)); return }
      if (kind === 'discard') { onDiscarded(id); return }
      const plan = (result.value as { plan: string }).plan
      const switched = await api.planUse(repo, plan)
      if (!switched.ok) { setError(describeApiError(switched.error, switched.message)); return }
      onApproved(plan)
    } catch { setError(t('actions.noConnection')) }
    finally { setPending(false) }
  }
  return <article className="orc-draft" aria-label={t('panel.draft.review')}>
    <div className="orc-draft__head"><div><span className="orc-draft__eyebrow">{t('panel.draft.review')}</span><h1>{detail?.draft.goal ?? t('panel.draft.loading')}</h1>{detail ? <p>{t('panel.draft.source')}: {detail.draft.source === 'chat' ? t('panel.draft.chat') : detail.draft.source.name}</p> : null}</div><button type="button" className="orc-link" onClick={onClose}>{t('panel.draft.close')}</button></div>
    {error ? <p className="orc-error" role="alert">{error}</p> : null}
    {detail ? <>
      {detail.findings.length ? <section className="orc-draft__findings" aria-label={t('panel.draft.findings')}><h2>{t('panel.draft.findings')}</h2><ul>{detail.findings.map((finding, index) => <FindingRow key={`${finding.code}-${index}`} finding={finding} known={known} />)}</ul></section> : null}
      {detail.draft.decisions.length ? <section className="orc-draft__decisions"><h2>{t('panel.draft.decisions')}</h2><ul>{detail.draft.decisions.map((decision, index) => <li key={index}>{decision}</li>)}</ul></section> : null}
      <div className="orc-draft__lanes">{groups.map(({ lane, tasks }) => <section key={lane}><h2>{lane}</h2><ol>{tasks.map((task) => <li key={task.id} id={`draft-task-${task.id}`} className="orc-draft__task"><div className="orc-draft__task-head"><strong>{task.title}</strong><span>{task.id}</span></div><p className="orc-draft__identity">{t('panel.draft.class')}: {task.class} · {t('panel.draft.kind')}: {task.kind}</p><dl><dt>{t('panel.draft.deps')}</dt><dd>{task.deps.length ? task.deps.map((dep, i) => <span key={`${dep}-${i}`}>{i ? ', ' : ''}{known.has(dep) ? <a href={`#draft-task-${dep}`}>{dep}</a> : dep}</span>) : t('panel.draft.none')}</dd><dt>{t('panel.draft.acceptance')}</dt><dd>{task.acceptance.length ? <ul>{task.acceptance.map((item, i) => <li key={i}>{item}</li>)}</ul> : t('panel.draft.none')}</dd><dt>{t('panel.draft.sources')}</dt><dd>{task.sources.length ? <ul>{task.sources.map((source, i) => <li key={i}>{source}</li>)}</ul> : t('panel.draft.none')}</dd></dl><details><summary>{t('panel.draft.contract')}</summary><pre>{task.contract || t('panel.draft.none')}</pre></details></li>)}</ol></section>)}</div>
      <div className="orc-draft__actions"><button type="button" className="orc-draft__approve" disabled={pending || blocking.length > 0} title={blocking.length ? t('panel.draft.approveBlocked') : undefined} onClick={() => void act('approve')}>{t('panel.draft.approve')}</button>{blocking.length ? <span className="orc-draft__reason">{t('panel.draft.approveBlocked')}</span> : null}{confirmDiscard ? <span className="orc-draft__confirm">{t('panel.draft.discardConfirm')} <button type="button" disabled={pending} onClick={() => void act('discard')}>{t('panel.draft.discardYes')}</button><button type="button" onClick={() => setConfirmDiscard(false)}>{t('panel.draft.cancel')}</button></span> : <button type="button" className="orc-link" disabled={pending} onClick={() => setConfirmDiscard(true)}>{t('panel.draft.discard')}</button>}</div>
    </> : null}
  </article>
}
