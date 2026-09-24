import { useEffect, useState } from 'react'
import type { TaskDetail, TaskSnapshot, Trajectory, WorkerInfo } from '../../shared/types.js'
import { identityLabel, workerIdentity } from '../provider.js'
import { api } from '../api.js'
import { clock } from '../summary.js'
import { t, useLang } from '../i18n.js'
import { noteText } from '../note-text.js'
import type { TraceTarget } from './trace.js'
import { FilePreview, previewKind } from './file-preview.js'
import { KIND_NAME, offset, toSteps } from './trace-steps.js'

export type TabKey = 'overview' | 'activity' | 'changes' | 'contract'
export function resolveTab(value: string | undefined): TabKey {
  return value === 'activity' || value === 'changes' || value === 'contract' ? value : 'overview'
}

const EVENT_GLYPH: Record<string, string> = { action: '◎', file: '✎', message: '“', steer: '↻', problem: '⚠', final: '✓' }
const OUTCOME_LABEL: Record<string, string> = { get completed() { return t('panel.tabs.outcome.completed') }, get failed() { return t('panel.tabs.outcome.failed') }, get cancelled() { return t('panel.tabs.outcome.cancelled') } }
const NOTE_LABEL: Record<string, string> = { get steer() { return t('panel.tabs.note.steer') }, get reject() { return t('panel.tabs.note.reject') }, get accept() { return t('panel.tabs.note.accept') }, get comment() { return t('panel.tabs.note.comment') }, get check() { return t('panel.tabs.note.check') } }
type Event = TaskDetail['events'][number]
type FeedGroup = { kind: Event['kind']; ts: string; events: Event[] }

export function groupEvents(events: Event[]): FeedGroup[] {
  const groups: FeedGroup[] = []
  for (const event of events) {
    const last = groups.at(-1)
    if ((event.kind === 'action' || event.kind === 'file') && last?.kind === event.kind) last.events.push(event)
    else groups.push({ kind: event.kind, ts: event.ts, events: [event] })
  }
  return groups
}

const groupLabel = (kind: Event['kind'], n: number) => {
  return t(kind === 'file' ? 'panel.tabs.fileCount' : 'panel.tabs.actionCount', { count: n })
}

/** New feed lines never animate: the feed is read while it moves. */
export function FeedTab({ detail }: { detail: TaskDetail | null }) {
  useLang()
  if (!detail) return <p className="orc-meta">{t('panel.tabs.feedLoading')}</p>
  if (detail.kind === 'decision' && detail.runs.length === 0) {
    const accepted = detail.notes.filter((n) => n.type === 'accept').at(-1)
    return (
      <p className="orc-meta">
        {t('panel.tabs.humanDecision')}
        {detail.deps.length > 0 ? t('panel.tabs.afterTasks', { tasks: detail.deps.join(', ') }) : ''}.
        {accepted ? t('panel.tabs.decisionAccepted', { time: clock(accepted.at), text: noteText(accepted) }) : ''}
      </p>
    )
  }
  if (detail.events.length === 0) return <p className="orc-meta">{t('panel.tabs.noEvents')}</p>
  return (
    <ul className="orc-feed">
      {groupEvents(detail.events).map((group, i) => (
        <li key={`${group.ts}-${i}`} className={`orc-ev orc-ev--${group.kind}`}>
          <time className="orc-ev__time" dateTime={group.ts}>{clock(group.ts)}</time>
          <span className="orc-ev__kind" aria-hidden="true">{EVENT_GLYPH[group.kind] ?? '·'}</span>
          {(group.kind === 'action' || group.kind === 'file') && group.events.length > 1 ? (
            <details className="orc-feed__tools">
              <summary>
                <span className="orc-feed__tool-label">{groupLabel(group.kind, group.events.length)}</span>
                <span className="orc-feed__expand" aria-hidden="true">⌄</span>
              </summary>
              <ul>{group.events.map((event, j) => <li key={j} title={event.text}>{event.text}</li>)}</ul>
            </details>
          ) : group.kind === 'action' || group.kind === 'file' ? (
            <span className="orc-feed__tool-label" title={group.events[0]?.text}>{group.events[0]?.text}</span>
          ) : <span className="orc-ev__text">{group.kind === 'steer' ? <strong>{t('panel.tabs.yourSteer')} · </strong> : null}{group.events[0]?.text}</span>}
        </li>
      ))}
    </ul>
  )
}

/** Older runs have no normalized feed endpoint; the existing trace supplies their activity. */
export function OlderRunActivity({ root, taskId, runId }: { root: string; taskId: string; runId: string }) {
  useLang()
  const [trace, setTrace] = useState<Trajectory | null>(null)
  useEffect(() => {
    let alive = true
    setTrace(null)
    void api.trace(root, taskId, runId).then((result) => { if (alive && result.ok) setTrace(result.value) }).catch(() => {})
    return () => { alive = false }
  }, [root, taskId, runId])
  if (!trace) return <p className="orc-meta">{t('panel.trace.loading')}</p>
  return <ul className="orc-feed">{toSteps(trace).map((step) => <li key={step.key} className="orc-ev"><i className="orc-ev__time">{offset(step.start, trace.start)}</i><span className="orc-ev__text"><strong>{KIND_NAME[step.kind]}</strong> · {step.label}</span></li>)}</ul>
}

function Diff({ text }: { text: string }) {
  return (
    /* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */ <pre className="orc-code" aria-label={t('panel.tabs.fileDiff')}>
      {text.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++') ? 'orc-diff__add' : line.startsWith('-') && !line.startsWith('---') ? 'orc-diff__del' : undefined
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        )
      })}
    </pre>
  )
}

export function ChangesTab({ detail, root }: { detail: TaskDetail | null; root: string }) {
  useLang()
  const [file, setFile] = useState<string | null>(null)
  const [diff, setDiff] = useState<string>('')
  const [mode, setMode] = useState<'preview' | 'diff'>('diff')
  const [expanded, setExpanded] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    setFile(null)
    setDiff('')
    setExpanded(false)
  }, [detail?.id])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!detail || !file || mode !== 'diff') return
    let alive = true
    api
      .diff(root, detail.id, file)
      .then((text) => {
        if (alive) setDiff(text)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root, detail?.id, file, mode])

  useEffect(() => {
    if (!expanded) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  if (!detail) return <p className="orc-meta">{t('panel.tabs.changesLoading')}</p>
  if (detail.changedFiles.length === 0) return <p className="orc-meta">{t('panel.tabs.noChanges')}</p>
  return (
    <>
      <ul className="orc-list">
        {detail.changedFiles.map((name) => (
          <li key={name}>
            <button type="button" className="orc-link" aria-pressed={file === name} onClick={() => { setFile(file === name ? null : name); setMode(previewKind(name) === 'diff' ? 'diff' : 'preview'); setDiff('') }}>
              {name}
            </button>
          </li>
        ))}
      </ul>
      {file ? <><div className="orc-preview-controls">
        {previewKind(file) !== 'diff' ? <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>{t('panel.preview.preview')}</button> : null}
        <button type="button" aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>{t('panel.preview.diff')}</button>
        {mode === 'preview' ? <button type="button" onClick={() => setExpanded(true)}>{t('panel.preview.fullSize')}</button> : null}
      </div>
        {mode === 'preview' ? <FilePreview repo={root} id={detail.id} file={file} /> : diff ? <Diff text={diff} /> : <p className="orc-meta">{t('panel.tabs.emptyDiff')}</p>}
        {expanded ? <div className="orc-preview-modal" role="dialog" aria-modal="true" aria-label={file}><button type="button" onClick={() => setExpanded(false)}>{t('panel.preview.close')}</button><h2>{file}</h2><FilePreview repo={root} id={detail.id} file={file} expanded /></div> : null}
      </> : null}
    </>
  )
}

export function ContractTab({ detail }: { detail: TaskDetail | null }) {
  useLang()
  if (!detail) return <p className="orc-meta">{t('panel.tabs.contractLoading')}</p>
  if (!detail.contract) return <p className="orc-meta">{t('panel.tabs.noContract')}</p>
  return (
    <>
      <p className="orc-meta orc-contract-path" title={detail.contract.path}>{detail.contract.path.length > 32 ? `${detail.contract.path.slice(0, 13)}…${detail.contract.path.slice(-18)}` : detail.contract.path}</p>
      <pre className="orc-code">{detail.contract.text}</pre>
      {detail.contract.truncated ? <p className="orc-meta">{t('panel.tabs.truncated')}</p> : null}
    </>
  )
}

export function RunsTab({ detail, workers, onTrace }: { detail: TaskDetail | null; workers?: readonly WorkerInfo[]; onTrace?(target: TraceTarget): void }) {
  useLang()
  if (!detail) return <p className="orc-meta">{t('panel.tabs.runsLoading')}</p>
  if (detail.runs.length === 0) return <p className="orc-meta">{t('panel.tabs.noRuns')}</p>
  return (
    <>
      <ul className="orc-list">
        {detail.runs.map((run) => (
          <li key={run.runId} className="orc-ev">
            <i className="orc-ev__time">{clock(run.startedAt)}</i>
            <span className="orc-ev__text">
              {identityLabel(workerIdentity(run.agent, workers))} · {run.outcome ? OUTCOME_LABEL[run.outcome] : t('panel.tabs.runActive')} · <code>{run.runId}</code>
              {onTrace ? (
                <button
                  type="button"
                  className="orc-more"
                  onClick={() =>
                    onTrace({
                      taskId: detail.id,
                      taskTitle: detail.title,
                      run: { runId: run.runId, agent: run.agent, startedAt: run.startedAt, active: !run.finishedAt },
                    })
                  }
                >
                  {t('panel.tabs.trace')} →
                </button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

export function NotesTab({ detail }: { detail: TaskDetail | null }) {
  useLang()
  if (!detail) return <p className="orc-meta">{t('panel.tabs.notesLoading')}</p>
  // Corrections with a lifecycle record are listed under Corrections; their audit notes would repeat them.
  const tracked = (detail.steers?.length ?? 0) > 0
  const notes = tracked ? detail.notes.filter((note) => note.type !== 'steer' && !(note.type === 'comment' && (note.event?.kind === 'steer' || /^(delivered|failed|refused|abandoned)\b/.test(note.text)))) : detail.notes
  if (notes.length === 0) return <p className="orc-meta">{t('panel.tabs.noNotes')}</p>
  return (
    <ul className="orc-list" aria-label={t('panel.tabs.notesLabel')}>
      {notes.map((note, i) => (
        <li key={`${note.at}-${i}`} className="orc-ev">
          <i className="orc-ev__time">{clock(note.at)}</i>
          <span className="orc-ev__text">
            {NOTE_LABEL[note.type] ?? note.type}: {noteText(note)}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function LinksTab({ task, detail, onSelect }: { task: TaskSnapshot; detail: TaskDetail | null; onSelect(id: string): void }) {
  useLang()
  const deps = task.deps
  const dependents = detail?.dependents ?? []
  const list = (title: string, ids: string[], empty: string) => (
    <>
      <p className="orc-meta">{title}</p>
      {ids.length === 0 ? <p className="orc-meta">{empty}</p> : (
        <ul className="orc-relation-list">
          {ids.map((id) => (
            <li key={id}>
              <button type="button" className="orc-relation-chip" onClick={() => onSelect(id)} title={id}>
                {id}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
  return (
    <>
      {list(t('panel.tabs.before'), deps, t('panel.tabs.noDependencies'))}
      {list(t('panel.tabs.after'), dependents, t('panel.tabs.noDependents'))}
    </>
  )
}
