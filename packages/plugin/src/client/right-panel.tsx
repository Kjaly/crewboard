import { runDuration } from './provider.js'
import { t, useLang } from './i18n.js'
import { type ReactNode, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { PANEL_ID, type OrchestraRepoSnapshot, type OrchestraSnapshot, type TaskDetail, type TaskSnapshot } from '../shared/types.js'
import { useAction } from './actions.js'
import { api } from './api.js'
import { usePlanCost } from './insight.js'
import { reportLine } from './panel/report.js'
import { acceptableTasks } from './review.js'
import { orchestraStore } from './store.js'
import { ensureStyles, taskTone } from './styles.js'
import { waitLabels } from './views/accept-batch.js'

/**
 * list and actions only; the graph stays on the big screen). The tab learns its session from the
 * slot's standard props (`sessionId` + `useSessions`), the workspace from `byId[sessionId].cwd`,
 * and the plan from the same SSE-fed snapshot store the screen uses.
 */

/** The slice of `SessionListState` this tab reads; the slots package is not on disk, so the shape is local. */
export type SessionSlice = { byId?: Record<string, { cwd?: string } | undefined> }
/** `GlobalStandardProps.useSessions` — a selector hook the session-scoped seat hands to its body. */
export type UseSessions = <T>(select: (state: SessionSlice) => T) => T

export type RightPanelProps = {
  /** Standard prop of the session-scoped seat: the session this tab belongs to. */
  sessionId?: string
  useSessions?: UseSessions
}

/**
 * The only path from a slot body to `ctx.layout`: the registration captures it here. Tests set it
 */
export const rightPanelHost: { selectPanel?: (key: string) => void } = {}

const FILES_SHOWN = 8

const readSnapshot = () => orchestraStore.getState().snapshot

/**
 * The repo of the session's workspace. A session may run in a subdirectory of its workspace root,
 * so after the exact match we accept the longest root that contains the cwd.
 */
export function repoForCwd(snapshot: OrchestraSnapshot | null, cwd: string | undefined): OrchestraRepoSnapshot | undefined {
  const dir = cwd?.replace(/\/+$/, '')
  if (!dir) return undefined
  const repos = snapshot?.repos ?? []
  return repos.find((r) => r.root === dir) ?? repos.filter((r) => dir.startsWith(`${r.root}/`)).sort((a, b) => b.root.length - a.root.length)[0]
}

type Binding = 'own' | 'other' | 'none'
const BINDING_LABEL: Record<Binding, string> = {
  get own() { return t('panel.side.own') },
  get other() { return t('panel.side.other') },
  get none() { return t('panel.side.none') },
}

/** The plan this snapshot is showing — the binding lives on its summary (`chats.json` from 2i). */
function currentPlan(repo: OrchestraRepoSnapshot) {
  const plans = repo.plans ?? []
  return plans.find((p) => p.current) ?? plans.find((p) => p.id === repo.planId)
}

const baseName = (root: string) => root.split('/').filter(Boolean).pop() || root

/* ----------------------------------------------------------------- states */

function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="orc-rp__empty">
      <p className="orc-rp__lead">{title}</p>
      {children}
    </div>
  )
}

function NoPlan({ repo }: { repo: OrchestraRepoSnapshot }) {
  const action = useAction()
  const [goal, setGoal] = useState('')
  const submit = () => {
    const g = goal.trim()
    if (!g) return
    void action.call(() => api.planInit(repo.root, g))
  }
  return (
    <div className="orc-rp__scroll">
      <div className="orc-rp__empty">
        <h2 className="orc-rp__title">{repo.title || baseName(repo.root)}</h2>
        <p className="orc-rp__lead">{t('panel.side.noPlan')}</p>
        <p className="orc-meta">{t('panel.side.noPlanHelp')}</p>
        <form
          className="orc-form"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <input
            className="orc-plans__field"
            aria-label={t('panel.side.goalAria')}
            placeholder={t('panel.side.goalPlaceholder')}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          <div className="orc-actions">
            <button type="submit" className="orc-btn" disabled={action.pending || !goal.trim()}>
              {t('panel.side.startPlan')}
            </button>
          </div>
        </form>
        {action.error ? (
          <p className="orc-error" role="status">
            {action.error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ rows */

/**
 * the report line need it; expanding the row reuses the same detail for the file list. Accept and
 * return go through the same routes — and the same macOS confirm — as the queue on the big screen.
 */
function ReviewRow({ root, task, wait, onOpenTask }: { root: string; task: TaskSnapshot; wait?: string; onOpenTask(id: string): void }) {
  const action = useAction()
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const tone = taskTone(task)
  const decision = task.kind === 'decision'

  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let alive = true
    api
      .task(root, task.id)
      .then((r) => {
        if (alive) setDetail(r.ok ? r.value : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [root, task.id, task.runs, task.lastRunId])

  const files = detail?.changedFiles
  const report = detail?.report?.text.trim() ? reportLine(detail.report.text) : undefined
  const meta = [decision ? t('panel.side.decisionYours') : (task.worker ?? '—'), wait, files && files.length > 0 ? t('panel.side.files', { count: files.length }) : undefined]
    .filter(Boolean)
    .join(' · ')

  return (
    <li className="orc-qrow">
      <button type="button" className="orc-qrow__top" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
          {tone.glyph}
        </span>
        <span className="orc-card__id">{task.id}</span>
        <span className="orc-card__title">{task.title}</span>
        <span className="orc-qrow__chev" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {report ? <span className="orc-qrow__report">{report}</span> : null}
      <span className="orc-meta">{meta}</span>

      {open ? (
        <div className="orc-qrow__detail">
          {!detail ? (
            <span className="orc-meta">{t('panel.side.counting')}</span>
          ) : files && files.length > 0 ? (
            <ul className="orc-qrow__files">
              {files.slice(0, FILES_SHOWN).map((file) => (
                <li key={file}>
                  <code>{file}</code>
                </li>
              ))}
              {files.length > FILES_SHOWN ? <li className="orc-meta">{t('panel.side.moreFiles', { count: files.length - FILES_SHOWN })}</li> : null}
            </ul>
          ) : (
            <span className="orc-meta">{decision ? t('panel.side.noChangesDecision') : t('panel.side.noChanges')}</span>
          )}
        </div>
      ) : null}

      <div className="orc-qrow__acts">
        <button type="button" className="orc-btn" disabled={action.pending} onClick={() => action.call(() => api.accept(root, task.id))}>
          {t('panel.side.accept')}
        </button>
        <button type="button" className="orc-btn orc-btn--ghost" onClick={() => onOpenTask(task.id)}>
          {decision ? t('panel.side.open') : t('panel.side.changes')}
        </button>
        <button type="button" className="orc-btn orc-btn--ghost" aria-expanded={rejecting} onClick={() => setRejecting(!rejecting)}>
          {t('panel.side.sendBack')}
        </button>
      </div>

      {rejecting ? (
        <div className="orc-form">
          <textarea
            // The reason is mandatory — the worker will read it.
            // biome-ignore lint/a11y/noAutofocus: Focus moves to this field when its dialog opens.
            autoFocus
            className="orc-field"
            aria-label={t('panel.side.rejectAria', { id: task.id })}
            placeholder={t('panel.side.rejectPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="orc-actions">
            <button
              type="button"
              className="orc-btn"
              disabled={action.pending || !reason.trim()}
              onClick={() =>
                action.call(() => api.reject(root, task.id, reason.trim())).then((ok) => {
                  if (ok) {
                    setRejecting(false)
                    setReason('')
                  }
                })
              }
            >
              {t('panel.side.sendBackNow')}
            </button>
            <button type="button" className="orc-btn orc-btn--ghost" onClick={() => setRejecting(false)}>
              {t('panel.side.cancel')}
            </button>
          </div>
          <p className="orc-hint">{t('panel.side.confirmHint')}</p>
        </div>
      ) : null}

      {action.error ? (
        <p className="orc-error" role="status">
          {action.error}
        </p>
      ) : null}
    </li>
  )
}

/** A running task: worker and elapsed time. The title opens the task on the big screen. */
function RunningRow({ task, now, onOpenTask }: { task: TaskSnapshot; now: Date; onOpenTask(id: string): void }) {
  const tone = taskTone(task)
  const since = runDuration(task.activeSince, now)
  const meta = [task.worker ?? t('panel.side.worker'), since ? t('panel.side.runningSince', { since }) : undefined].filter(Boolean).join(' · ')
  return (
    <li className="orc-qrow">
      <button type="button" className="orc-qrow__top" title={t('panel.side.openScreen')} onClick={() => onOpenTask(task.id)}>
        <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
          <span className="orc-pulse" aria-hidden="true" />
        </span>
        <span className="orc-card__id">{task.id}</span>
        <span className="orc-card__title">{task.title}</span>
      </button>
      <span className="orc-meta">{meta}</span>
    </li>
  )
}

function ReadyRow({ root, task }: { root: string; task: TaskSnapshot }) {
  const action = useAction()
  const tone = taskTone(task)
  return (
    <li className="orc-qrow">
      <div className="orc-qrow__top">
        <span className="orc-glyph" style={{ color: tone.color }} aria-hidden="true">
          {tone.glyph}
        </span>
        <span className="orc-card__id">{task.id}</span>
        <span className="orc-card__title">{task.title}</span>
      </div>
      <span className="orc-meta">{task.worker ?? t('panel.side.workerAuto')}</span>
      <div className="orc-qrow__acts">
        <button type="button" className="orc-btn" disabled={action.pending} onClick={() => action.call(() => api.run(root, task.id))}>
          {t('panel.side.run')}
        </button>
      </div>
      {action.error ? (
        <p className="orc-error" role="status">
          {action.error}
        </p>
      ) : null}
    </li>
  )
}

/* ------------------------------------------------------------------ plan */

function PlanView({ repo, sessionId }: { repo: OrchestraRepoSnapshot; sessionId?: string }) {
  const bind = useAction()
  // The SSE snapshot is the source of truth; the optimistic flag only covers the frames in flight.
  const [boundHere, setBoundHere] = useState(false)
  const review = useMemo(() => acceptableTasks(repo), [repo])
  const reviewIds = useMemo(() => new Set(review.map((t) => t.id)), [review])
  const running = repo.tasks.filter((t) => t.status === 'running')
  const ready = repo.tasks.filter((t) => t.status === 'ready' && !reviewIds.has(t.id))
  const { cost } = usePlanCost(repo.root, repo.rev)
  const waits = useMemo(() => waitLabels(cost, new Date()), [cost])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  const now = useMemo(() => new Date(), [repo.updatedAt])

  const boundTo = currentPlan(repo)?.chat?.sessionId
  const binding: Binding = boundTo ? (boundTo === sessionId ? 'own' : 'other') : boundHere ? 'own' : 'none'
  const planName = repo.goal || repo.title || baseName(repo.root)

  const openScreen = (taskId?: string) => {
    orchestraStore.setRepo(repo.root)
    if (taskId) orchestraStore.selectIn(repo.root, repo.planId, taskId)
    rightPanelHost.selectPanel?.(PANEL_ID)
  }
  const bindHere = () => {
    if (!sessionId) return
    void bind.call(() => api.chatBind(repo.root, sessionId, repo.planId)).then((ok) => {
      if (ok) setBoundHere(true)
    })
  }

  return (
    <>
      <header className="orc-rp__head">
        <h2 className="orc-rp__title">{planName}</h2>
        <p className="orc-rp__sub">
          {t('panel.side.tasks', { count: repo.tasks.length })} · {BINDING_LABEL[binding]}
        </p>
        {binding !== 'own' && sessionId ? (
          <button type="button" className="orc-btn orc-btn--ghost orc-rp__bind" disabled={bind.pending} onClick={bindHere}>
            {t('panel.side.bind')}
          </button>
        ) : null}
        {bind.error ? (
          <p className="orc-error" role="status">
            {bind.error}
          </p>
        ) : null}
      </header>

      <div className="orc-rp__scroll">
        {review.length === 0 && running.length === 0 && ready.length === 0 ? (
          <p className="orc-rp__calm">{t('panel.side.calm')}</p>
        ) : null}

        {review.length > 0 ? (
          <section className="orc-rp__block" aria-label={t('panel.side.review')}>
            <h3 className="orc-rp__label orc-rp__label--warn">{t('panel.side.reviewCount', { count: review.length })}</h3>
            <ul className="orc-rp__list">
              {review.map((task) => (
                <ReviewRow key={task.id} root={repo.root} task={task} wait={waits.get(task.id)} onOpenTask={openScreen} />
              ))}
            </ul>
            <p className="orc-hint">{t('panel.side.confirmHint')}</p>
          </section>
        ) : null}

        {running.length > 0 ? (
          <section className="orc-rp__block" aria-label={t('panel.side.now')}>
            <h3 className="orc-rp__label">{t('panel.side.now')}</h3>
            <ul className="orc-rp__list">
              {running.map((task) => (
                <RunningRow key={task.id} task={task} now={now} onOpenTask={openScreen} />
              ))}
            </ul>
          </section>
        ) : null}

        {ready.length > 0 ? (
          <section className="orc-rp__block" aria-label={t('panel.side.ready')}>
            <h3 className="orc-rp__label">{t('panel.side.readyCount', { count: ready.length })}</h3>
            <ul className="orc-rp__list">
              {ready.map((task) => (
                <ReadyRow key={task.id} root={repo.root} task={task} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <footer className="orc-rp__foot">
        <button
          type="button"
          className="orc-btn orc-btn--ghost"
          disabled={!rightPanelHost.selectPanel}
          title={rightPanelHost.selectPanel ? undefined : t('panel.side.unavailable')}
          onClick={() => openScreen()}
        >
          {t('panel.side.openGraph')}
        </button>
        <button
          type="button"
          className="orc-btn orc-btn--ghost"
          disabled={!rightPanelHost.selectPanel}
          title={
            rightPanelHost.selectPanel
              ? t('panel.side.newTaskHint')
              : t('panel.side.unavailable')
          }
          onClick={() => openScreen()}
        >
          {t('panel.side.newTask')}
        </button>
      </footer>
    </>
  )
}

/* ----------------------------------------------------------------- body */

export function RightPanel({ sessionId, useSessions }: RightPanelProps) {
  return useSessions
    ? <SessionRightPanel sessionId={sessionId} useSessions={useSessions} />
    : <RightPanelBody cwd={undefined} sessionId={sessionId} />
}

function SessionRightPanel({ sessionId, useSessions }: { sessionId?: string; useSessions: UseSessions }) {
  const cwd = useSessions((s) => (sessionId ? s.byId?.[sessionId]?.cwd : undefined))
  return <RightPanelBody cwd={cwd} sessionId={sessionId} />
}

function RightPanelBody({ cwd, sessionId }: { cwd: string | undefined; sessionId?: string }) {
  useLang()
  ensureStyles()
  const snapshot = useSyncExternalStore(orchestraStore.subscribe, readSnapshot, readSnapshot)
  const repo = repoForCwd(snapshot, cwd)

  let body: ReactNode
  if (!cwd) {
    body = <EmptyState title={t('panel.side.noCwd')} />
  } else if (!snapshot) {
    body = <EmptyState title={t('panel.side.connecting')} />
  } else if (!repo) {
    body = (
      <EmptyState title={t('panel.side.untracked')}>
        <p className="orc-meta">{t('panel.side.untrackedHelp')}</p>
      </EmptyState>
    )
  } else if (repo.hasPlan === false) {
    body = <NoPlan repo={repo} />
  } else if (repo.degraded && repo.error) {
    body = (
      <EmptyState title={t('panel.side.unreadable')}>
        <p className="orc-error">{repo.error}</p>
      </EmptyState>
    )
  } else {
    body = <PlanView key={repo.root} repo={repo} sessionId={sessionId} />
  }

  return (
    <section className="orc-rp" aria-label={t('panel.side.tab')} data-orchestra-tab="panel">
      {body}
    </section>
  )
}
