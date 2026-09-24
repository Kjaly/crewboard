import { useEffect, useState } from 'react'
import type { RepoSnapshot, TaskDetail, TaskSnapshot, WorkerInfo } from '../../shared/types.js'
import { api } from '../api.js'
import { identityLabel, workerIdentity } from '../provider.js'
import { t, useLang } from '../i18n.js'

const CHECK = /^\s*- \[[ xX]\]\s+(.+)$/

type SavedChecks = { revision: string; items: string[] }

function savedChecks(key: string): SavedChecks | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (Array.isArray(value)) {
      localStorage.removeItem(key)
      return null
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const saved = value as { version?: unknown; revision?: unknown; items?: unknown }
    if (saved.version !== 1 || typeof saved.revision !== 'string' || !Array.isArray(saved.items)) return null
    return { revision: saved.revision, items: saved.items.filter((item): item is string => typeof item === 'string') }
  } catch {
    return null
  }
}

function fileLabel(n: number): string { return t('panel.decision.fileCount', { count: n }) }

export function DecisionBrief({ repo, workers, task, detail, onSelect }: {
  repo: RepoSnapshot
  workers?: readonly WorkerInfo[]
  task: TaskSnapshot
  detail: TaskDetail | null
  onSelect(id: string): void
}) {
  useLang()
  const storageKey = `crewboard:decision-checks:${repo.root}:${repo.planId ?? ''}:${task.id}`
  const contract = detail?.contract
  const revision = contract?.text ?? ''
  const [checked, setChecked] = useState<string[]>(() => {
    const saved = savedChecks(storageKey)
    return saved?.items ?? []
  })
  const [predecessors, setPredecessors] = useState<Record<string, TaskDetail>>({})
  const [predecessorsLoaded, setPredecessorsLoaded] = useState(false)
  const deps = detail?.deps ?? task.deps
  const depsKey = deps.join('\0')

  useEffect(() => {
    const saved = savedChecks(storageKey)
    // Previous index-only values cannot be tied to contract text, so they are discarded.
    setChecked(saved?.items ?? [])
  }, [storageKey])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    let alive = true
    setPredecessors({})
    setPredecessorsLoaded(false)
    void Promise.all(deps.map(async (id) => {
      try {
        const result = await api.task(repo.root, id)
        return result.ok ? result.value : null
      } catch {
        return null
      }
    })).then((results) => {
      if (alive) {
        setPredecessors(Object.fromEntries(results.filter((item): item is TaskDetail => item !== null).map((item) => [item.id, item])))
        setPredecessorsLoaded(true)
      }
    })
    return () => { alive = false }
  }, [repo.root, depsKey])

  const lines = contract?.text.split(/\r?\n/) ?? []
  const textLines: Array<{ text: string; line: number }> = []
  const checks = lines.flatMap((line, index) => {
    const match = CHECK.exec(line)
    if (!match) {
      if (line.trim()) textLines.push({ text: line, line: index })
      return []
    }
    const item = match[1]
    const itemKey = `${revision}\u0000${item}`
    const isChecked = checked.includes(item)
    return [<label className="orc-decision__check" key={itemKey}>
      <input type="checkbox" checked={isChecked} onChange={() => {
        const next = isChecked ? checked.filter((text) => text !== item) : [...checked, item]
        setChecked(next)
        try { localStorage.setItem(storageKey, JSON.stringify({ version: 1, revision, items: next })) } catch { /* scratch state remains in memory */ }
      }} />
      <span>{item}</span>
    </label>]
  })
  const total = deps.reduce((n, id) => n + (predecessors[id]?.changedFiles.length ?? 0), 0)
  const allLoaded = deps.every((id) => predecessors[id])

  return <div className="orc-decision">
    <section className="orc-sec" aria-label={t('panel.decision.whatToCheck')}>
      <h3 className="orc-decision__heading">{t('panel.decision.whatToCheck')}</h3>
      {contract ? <>
        <div className="orc-decision__source" title={contract.path}>{contract.path}</div>
        <div className="orc-decision__content">
          {textLines.map(({ text, line }) => <p className="orc-decision__text" key={line}>{text}</p>)}
          {checks}
        </div>
        {contract.truncated ? <p className="orc-meta">{t('panel.decision.contractTruncated')}</p> : null}
      </> : detail ? <p className="orc-meta">{t('panel.decision.noChecklist')}</p> : null}
    </section>
    <section className="orc-sec" aria-label={t('panel.decision.whereToLook')}>
      <h3 className="orc-decision__heading">{t('panel.decision.whereToLook')}</h3>
      {deps.length ? <>
        <p className="orc-decision__total">{allLoaded ? t('panel.decision.totalChanged', { count: total, files: fileLabel(total) }) : predecessorsLoaded ? t('panel.decision.countUnavailable') : t('panel.decision.countLoading')}</p>
        <ul className="orc-decision__deps">{deps.map((id) => {
          const item = predecessors[id]
          const snapshot = repo.tasks.find((candidate) => candidate.id === id)
          const verdict = item?.verdict.kind
          const agent = item?.runs.at(-1)?.agent ?? item?.worker ?? snapshot?.worker
          return <li key={id}>
            <button type="button" className="orc-decision__link" onClick={() => onSelect(id)}>
              <span className="orc-decision__mark" aria-hidden="true">{verdict === 'result' ? '✓' : verdict === 'negative' ? '−' : verdict === 'disputed' ? '?' : '·'}</span>
              <span className="orc-decision__dep-title">{snapshot?.title ?? item?.title ?? id}</span>
            </button>
            <span className="orc-decision__dep-meta">{verdict === 'negative' ? t('panel.decision.negativeResult') : verdict === 'disputed' ? t('panel.decision.disputedVerdict') : verdict === 'result' ? t('panel.decision.resultReceived') : t('panel.decision.verdictUnavailable')} · {agent ? identityLabel(workerIdentity(agent, workers)) : t('panel.decision.modelUnknown')} · {item ? t('panel.decision.filesChanged', { count: item.changedFiles.length, files: fileLabel(item.changedFiles.length) }) : t('panel.decision.filesUnavailable')}{snapshot?.closed === 'negative' ? t('panel.decision.closedNegative') : ''}</span>
          </li>
        })}</ul>
      </> : <p className="orc-meta">{t('panel.decision.noPredecessors')}</p>}
    </section>
  </div>
}
