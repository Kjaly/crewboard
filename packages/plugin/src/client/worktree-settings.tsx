import { getLang, t, useLang } from './i18n.js'
import { useEffect, useState } from 'react'
import type { GcCandidate, WorktreePolicy } from '@crewboard/core'
import type { WorktreesInfo } from '../shared/types.js'
import { api } from './api.js'
import { WORKTREE_POLICIES } from './worktree-copy.js'

const gigabytes = (bytes: number) => (bytes / 1_000_000_000).toLocaleString(getLang() === 'ru' ? 'ru-RU' : 'en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })
const shortPath = (path: string) => path.length <= 48 ? path : `${path.slice(0, 20)}…${path.slice(-24)}`

export function WorktreeSettings({ repo }: { repo: string }) {
  useLang()
  const [info, setInfo] = useState<WorktreesInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = async () => {
    const result = await api.worktrees(repo)
    if (!result.ok) throw new Error(t('settings.worktrees.loadError'))
    setInfo(result.value)
    return result.value
  }
  useEffect(() => {
    let alive = true
    void api.worktrees(repo).then((result) => {
      if (!alive) return
      if (result.ok) setInfo(result.value)
      else setError(t('settings.worktrees.loadError'))
    }).catch(() => { if (alive) setError(t('settings.worktrees.connectionError')) })
    return () => { alive = false }
  }, [repo])

  const removable = info?.candidates.filter((candidate) => !candidate.keep) ?? []
  const selectedBytes = removable.reduce((sum, candidate) => sum + (candidate.sizeBytes ?? 0), 0)
  const unknownSize = removable.some((candidate) => candidate.sizeBytes === undefined)
  const remove = async () => {
    if (!removable.length || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.worktreeGc(repo, removable.map((candidate) => candidate.planId ? `${candidate.planId}:${candidate.taskId}` : candidate.taskId))
      if (!result.ok) throw new Error(t('settings.worktrees.removeError'))
      setConfirm(false)
      setMessage(t('settings.worktrees.removed', { count: result.value.removed.length }))
      if (result.value.failed.length) setError(t('settings.worktrees.remaining', { items: result.value.failed.map((item) => `${item.taskId} — ${item.reason}`).join('; ') }))
      await refresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('settings.worktrees.connectionError')) }
    finally { setBusy(false) }
  }
  const changePolicy = async (policy: WorktreePolicy) => {
    if (!info || busy) return
    setBusy(true)
    setError('')
    try {
      const result = await api.worktreePolicy(repo, policy)
      if (!result.ok) throw new Error(t('settings.worktrees.policyError'))
      setInfo({ ...info, policy: result.value.policy })
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('settings.worktrees.connectionError')) }
    finally { setBusy(false) }
  }
  const candidateRow = (candidate: GcCandidate) => <li key={candidate.path} className="orc-worktrees__item">
    <span className="orc-worktrees__path"><strong>{candidate.planId ? `${candidate.planId}/` : ''}{candidate.taskId}</strong> · <code className="orc-path" title={candidate.path}>{shortPath(candidate.path)}</code></span>
    <span>{candidate.sizeBytes === undefined ? t('settings.worktrees.unknownSize') : t('settings.worktrees.gigabytes', { size: gigabytes(candidate.sizeBytes) })}</span>
    <span className="orc-worktrees__reason">{candidate.orphan ? t(candidate.registeredWorktree ? 'settings.worktrees.orphanRegistered' : 'settings.worktrees.orphanUnknown') : candidate.keep ? t(`settings.worktrees.keep.${candidate.keep}`) : t('settings.worktrees.removable')}</span>
    {candidate.keep === 'dirty' ? <span className="orc-worktrees__reason">{t('settings.worktrees.dirtyDetails', { modified: candidate.modifiedCount ?? 0, untracked: candidate.untrackedCount ?? 0, paths: candidate.dirtyPaths?.join(', ') ?? '', artifacts: t(candidate.artefactOnly ? 'settings.worktrees.artifactsOnly' : 'settings.worktrees.notArtifactsOnly') })}</span> : null}
  </li>

  return <section className="orc-block orc-worktrees" aria-label={t('settings.worktrees.title')}>
    <h2 className="orc-block__head">{t('settings.worktrees.title')}</h2>
    <div className="orc-worktrees__summary">
      <span>{info ? t('settings.worktrees.summary', { count: info.candidates.length, size: gigabytes(info.totalBytes) }) : t('settings.worktrees.loading')}</span>
      <button type="button" disabled={!info} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t('settings.worktrees.hide') : t('settings.worktrees.show')}</button>
      <button type="button" disabled={!removable.length || busy} onClick={() => setConfirm(true)}>{t('settings.worktrees.removeExtras')}</button>
    </div>
    {open ? <ul className="orc-set__list orc-worktrees__list">{info?.candidates.length ? info.candidates.map(candidateRow) : <li>{t('settings.worktrees.empty')}</li>}</ul> : null}
    {confirm ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-wrow__confirm" role="group" aria-label={t('settings.worktrees.confirmAria')}>
      <span>{t(unknownSize ? 'settings.worktrees.confirmUnknown' : 'settings.worktrees.confirm', { count: removable.length, size: gigabytes(selectedBytes) })}</span>
      <button type="button" className="orc-danger" disabled={busy || !removable.length} onClick={() => void remove()}>{t('settings.worktrees.remove')}</button>
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>{t('settings.worktrees.cancel')}</button>
    </div> : null}
    <label className="orc-worktrees__policy">{t('settings.worktrees.policyLabel')}<select className="orc-select" value={info?.policy ?? '\u043f\u043e\u0441\u043b\u0435 \u043f\u0440\u0438\u0451\u043c\u043a\u0438'} disabled={!info || busy} onChange={(event) => void changePolicy(event.target.value as WorktreePolicy)}>
      {WORKTREE_POLICIES.map((policy) => <option key={policy} value={policy}>{t(`settings.worktrees.policy.${WORKTREE_POLICIES.indexOf(policy)}`)}</option>)}
    </select></label>
    {error ? <p className="orc-error" role="alert">{error}</p> : null}
    {message ? <p className="orc-hint" role="status">{message}</p> : null}
  </section>
}
