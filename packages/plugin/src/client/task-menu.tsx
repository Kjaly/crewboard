import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OrchestraRepoSnapshot, TaskDetail, TaskSnapshot, WorkerInfo } from '../shared/types.js'
import { api } from './api.js'
import { waitsForHuman } from '../../../core/src/plan/graph.js'
import { t } from './i18n.js'
import { orchestraStore } from './store.js'
import { classOfTask } from './routing.js'
import { workerOptions } from './workers.js'
import { identityLabel, workerIdentity } from './provider.js'
import { openSession } from './layout.js'

export type MenuRequest = { taskId: string; selectedIds?: string[]; x: number; y: number; origin: HTMLElement }
type Item = { label: string; action: () => void | Promise<void>; children?: Item[] }

const slug = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'follow-up'
export function nextTaskId(title: string, tasks: readonly TaskSnapshot[]): string {
  const base = slug(title)
  const taken = new Set(tasks.map((task) => task.id))
  let id = base
  let number = 2
  while (taken.has(id)) id = `${base.slice(0, 36)}-${number++}`
  return id
}

export function TaskMenu({ request, repo, workers, onClose, onSelect, onTab, onTrace, onGraph }: {
  request: MenuRequest
  repo: OrchestraRepoSnapshot
  workers: readonly WorkerInfo[]
  onClose(): void
  onSelect(id: string): void
  onTab(tab: 'contract' | 'changes' | 'overview'): void
  onTrace(detail?: TaskDetail): void
  onGraph(): void
}) {
  const task = repo.tasks.find((item) => item.id === request.taskId)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [form, setForm] = useState<'follow' | 'replace' | 'steer' | 'return' | 'relaunch' | null>(null)
  const [title, setTitle] = useState('')
  const [taskClass, setTaskClass] = useState(task ? classOfTask(task) : 'code')
  const [lane, setLane] = useState(task?.lane ?? '')
  const [depends, setDepends] = useState(true)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [submenu, setSubmenu] = useState(false)
  const [index, setIndex] = useState(0)
  const [point, setPoint] = useState({ x: request.x, y: request.y })
  const box = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => {
    let alive = true
    void api.task(repo.root, request.taskId).then((result) => { if (alive && result.ok) setDetail(result.value) })
    return () => { alive = false }
  }, [repo.root, request.taskId, repo.rev])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect()
    if (rect) setPoint({ x: Math.max(8, Math.min(request.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(request.y, window.innerHeight - rect.height - 8)) })
  }, [request.x, request.y, form, submenu, detail])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) { onClose(); request.origin.focus() } }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [onClose, request.origin])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { box.current?.querySelector<HTMLElement>('[role="menuitem"], input')?.focus() }, [form, submenu])
  // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
  useEffect(() => { if (!form) box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]')[index]?.focus() }, [index, form, submenu])
  if (!task) return null
  const close = () => { onClose(); request.origin.focus() }
  const act = async (call: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try {
      const result = await call() as { ok: boolean; message?: string; error?: string }
      if (!result.ok) { setError(result.message ?? result.error ?? t('actions.failed', { error: 'unknown' })); return }
      close()
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  const openTab = (tab: 'contract' | 'changes' | 'overview') => { onSelect(task.id); onTab(tab); close() }
  const groups: Item[][] = []
  if (request.selectedIds && request.selectedIds.length > 1) {
    const selected = request.selectedIds.map((id) => repo.tasks.find((item) => item.id === id)).filter((item): item is TaskSnapshot => !!item)
    const batch: Item[] = []
    if (selected.length > 1 && selected.every((item) => waitsForHuman(item) || (item.kind === 'decision' && item.needsHuman))) batch.push({ label: t('menu.acceptSelected'), action: () => act(() => api.acceptBatch(repo.root, selected.map((item) => item.id))) })
    batch.push({ label: t('menu.highlight'), action: () => { onGraph(); close() } })
    groups.push(batch)
  } else {
  const main: Item[] = []
  if (task.status === 'in_review' || (task.kind === 'decision' && task.needsHuman)) {
    main.push({ label: t('menu.accept'), action: () => act(() => api.accept(repo.root, task.id)) }, { label: t('menu.return'), action: () => setForm('return') })
  }
  if (task.lastRunId && task.lastOutcome) main.push({ label: t('menu.report'), action: () => openTab('overview') })
  if (task.status === 'ready' || task.returned) {
    main.push({ label: t('menu.launch'), action: () => act(() => api.run(repo.root, task.id)) })
    main.push({ label: t('menu.launchWorker'), action: () => setSubmenu(true), children: [
      { label: t('panel.task.auto'), action: () => act(() => api.run(repo.root, task.id)) },
      ...(repo.effectiveRouting?.routing[classOfTask(task)] ?? workerOptions(task.worker ?? 'dsh', workers)).map((worker) => ({ label: identityLabel(workerIdentity(worker, workers)), action: () => act(() => api.run(repo.root, task.id, worker)) })),
    ] })
  }
  if (task.status === 'running') main.push({ label: t('menu.direction'), action: () => setForm('steer') }, { label: t('panel.task.stop'), action: () => act(() => api.stop(repo.root, task.id)) })
  if (task.lastOutcome === 'failed' || task.returned) main.push({ label: t('menu.relaunch'), action: () => setForm('relaunch') })
  if (main.length) groups.push(main)
  const look: Item[] = []
  if (task.lastRunId) look.push({ label: t('menu.ledger'), action: () => { onTrace(detail ?? undefined); close() } })
  if (detail?.changedFiles.length) look.push({ label: t('menu.changes'), action: () => openTab('changes') })
  if (detail?.contract) look.push({ label: t('menu.contract'), action: () => openTab('contract') })
  look.push({ label: t('menu.highlight'), action: () => { onGraph(); close() } })
  look.push({ label: t('menu.showGraph'), action: () => { onGraph(); close() } })
  groups.push(look)
  groups.push([
    { label: t('menu.follow'), action: () => setForm('follow') },
    { label: t('menu.askAgent'), action: async () => { const prompt = `${t('menu.chatPrompt')}\n${t('menu.chatTask')}: ${task.id} — ${task.title}\n${t('menu.chatVerdict')}: ${detail?.verdict.kind ?? t('menu.chatUnknown')}\n${t('menu.chatReport')}: ${detail?.report?.text.slice(0, 900) ?? t('menu.chatNoReport')}\n${t('menu.chatFindings')}: ${detail?.verdict.facts.map((fact) => fact.text ?? fact.code).join('; ') || t('menu.chatNone')}\n${t('menu.chatTool')}`; await act(async () => { const result = await api.chatOpen(repo.root, repo.planId, prompt); if (result.ok) await openSession(result.value.sessionId); return result }) } },
  ])
  if (detail?.worktree) groups.push([
    { label: t('menu.openEditor'), action: () => act(() => api.worktreeOpen(repo.root, task.id, false)) },
    { label: t('menu.revealFinder'), action: () => act(() => api.worktreeOpen(repo.root, task.id, true)) },
  ])
  const copy: Item[] = [
    { label: t('menu.copyLink'), action: () => { void navigator.clipboard.writeText(orchestraStore.taskLink(task.id)); close() } },
    { label: t('menu.copyId'), action: () => { void navigator.clipboard.writeText(task.id); close() } },
    { label: t('menu.copyCommand'), action: () => { void navigator.clipboard.writeText(`orch run ${task.id}`); close() } },
  ]
  groups.push(copy)
  const plan: Item[] = []
  if (task.status === 'ready') plan.push({ label: t('menu.backlog'), action: () => act(() => api.taskStatus(repo.root, task.id, 'backlog')) })
  if (task.status === 'backlog') plan.push({ label: t('menu.ready'), action: () => act(() => api.taskStatus(repo.root, task.id, 'ready')) })
  if (task.status !== 'superseded' && task.status !== 'running') plan.push({ label: t('menu.supersede'), action: () => { setDepends(false); setForm('replace') } })
  if (plan.length) groups.push(plan)
  }
  const items = (submenu ? groups[0]?.find((item) => item.children)?.children ?? [] : groups.flat())
  const handleKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); if (submenu) setSubmenu(false); else close(); return }
    if (form) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex((old) => (old + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length); return }
    if (event.key === 'ArrowRight' && items[index]?.children) { event.preventDefault(); setSubmenu(true); setIndex(0); return }
    if (event.key === 'ArrowLeft' && submenu) { event.preventDefault(); setSubmenu(false); setIndex(0); return }
    if (event.key === 'Enter') { event.preventDefault(); void items[index]?.action(); return }
    if (event.key.length === 1) { const found = items.findIndex((item) => item.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase())); if (found >= 0) setIndex(found) }
  }
  const create = async () => {
    const id = nextTaskId(title, repo.tasks)
    setBusy(true); setError('')
    try {
      const result = await api.taskUpsert(repo.root, { id, parent: task.id, title: title.trim(), class: taskClass, lane, depends, note, replace: form === 'replace' })
      if (!result.ok) { setError(result.message ?? result.error); return }
      onSelect(id); close()
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return /* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: This wrapper handles delegated pointer or keyboard events for its child controls. This label describes a styled presentation region or indicator. */ <div ref={box} className="orc-task-menu" style={{ left: point.x, top: point.y }} onKeyDown={(event) => { event.stopPropagation(); handleKey(event) }} role={form ? 'dialog' : 'menu'} aria-label={t('menu.aria')}>
    {form ? <div className="orc-task-menu__form">
      <strong>{t(form === 'follow' ? 'menu.follow' : form === 'replace' ? 'menu.supersede' : form === 'steer' ? 'menu.direction' : form === 'return' ? 'menu.return' : 'menu.relaunch')}</strong>
      {form === 'follow' || form === 'replace' ? <>
        {/* biome-ignore lint/a11y/noAutofocus: Focus moves to this field when its dialog opens. */} <input autoFocus aria-label={t('menu.title')} placeholder={t('menu.title')} value={title} onChange={(event) => setTitle(event.target.value)} />
        <label>{t('menu.class')}<select value={taskClass} onChange={(event) => setTaskClass(event.target.value as typeof taskClass)}>{(['code', 'design', 'review', 'research'] as const).map((value) => <option key={value} value={value}>{t(`settings.class.${value}`)}</option>)}</select></label>
        <label>{t('menu.lane')}<input value={lane} onChange={(event) => setLane(event.target.value)} /></label>
        {form === 'follow' ? <label><input type="checkbox" checked={depends} onChange={(event) => setDepends(event.target.checked)} />{t('menu.depends')}</label> : null}
      </> : null}
      <textarea aria-label={form === 'return' ? t('panel.task.reasonLabel') : form === 'steer' ? t('panel.task.steerLabel') : t('menu.note')} placeholder={form === 'return' ? t('panel.task.reasonPlaceholder') : form === 'steer' ? t('panel.task.steerPlaceholder') : t('menu.note')} value={note} onChange={(event) => setNote(event.target.value)} />
      <div className="orc-task-menu__buttons"><button type="button" disabled={busy || ((form === 'follow' || form === 'replace') ? !title.trim() : !note.trim())} onClick={() => {
        if (form === 'follow' || form === 'replace') void create()
        else if (form === 'steer') void act(() => api.steer(repo.root, task.id, note.trim()))
        else if (form === 'return') void act(() => api.reject(repo.root, task.id, note.trim()))
        else void act(() => api.relaunch(repo.root, task.id, { note: note.trim() }))
      }}>{t('menu.confirm')}</button><button type="button" onClick={close}>{t('panel.task.cancel')}</button></div>
    </div> : submenu ? items.map((item, i) => <button key={item.label} type="button" role="menuitem" tabIndex={i === index ? 0 : -1} onMouseEnter={() => setIndex(i)} onClick={() => void item.action()}>{item.label}</button>) : groups.map((group, gi) => <div key={gi} className="orc-task-menu__group">{group.map((item) => { const i = items.indexOf(item); return <button key={item.label} type="button" role="menuitem" tabIndex={i === index ? 0 : -1} onMouseEnter={() => setIndex(i)} onClick={() => void item.action()}>{item.label}{item.children ? ' ▸' : null}</button> })}</div>)}
    {error ? <p role="alert" className="orc-error">{error}</p> : null}
  </div>
}
