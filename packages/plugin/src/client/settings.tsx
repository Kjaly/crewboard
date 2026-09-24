import { getLang, t, useLang } from './i18n.js'
import { CLASS_LABEL } from './routing.js'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { PROFILE_ALIASES, type Routing, type TaskClass, type WorkerInfo, type WorkersInfo, type WorkerPreset, type OrchestraSnapshot } from '../shared/types.js'
import { NotifySettings } from './notify-settings.js'
import { describeApiError } from './actions.js'
import { type ApiResult, api } from './api.js'
import { agentBadge } from './insight.js'
import { ensureStyles } from './styles.js'
import { PANEL_ID } from '../shared/types.js'
import { selectMainPanel } from './layout.js'
import { TOUR_KEY } from './tour.js'
import { WorktreeSettings } from './worktree-settings.js'

/** Default reason when a worker is switched off — matches `orch workers disable`. */
const OFF_REASON = '\u043d\u0435\u0442 \u043b\u0438\u043c\u0438\u0442\u043e\u0432'
const SAVE_DELAY_MS = 300
/** A pointer has to travel this far before a row press becomes a drag — clicks stay clicks. */
const DRAG_THRESHOLD_PX = 4
const SETTLE_MS = 180

const CLASS_SHORT: Record<TaskClass, string> = { get code() { return t('settings.classShort.code') }, get design() { return t('settings.classShort.design') }, get review() { return t('settings.classShort.review') }, get research() { return t('settings.classShort.research') } }
const PROVIDER_ORDER: WorkerInfo['provider'][] = ['DeepSeek', 'Claude', 'Codex', 'Devin', '\u0414\u0440\u0443\u0433\u0438\u0435']
type WorkerKind = 'dsh' | 'claude' | 'codex' | 'devin'
type WorkerEntry = { id: string; kind: WorkerKind; model?: string; label: string; billing: 'API' | '\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0430' | '\u043f\u0440\u043e\u043c\u043e'; note?: string }
type Catalog = { groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; failures: Array<{ id: string; name: string; message: string }> }
type RegistryInfo = WorkersInfo & { registry?: WorkerEntry[]; catalog?: Catalog | null }
type AccessResult = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> }
const CLI_FAMILIES = [
  { kind: 'claude', name: 'Claude', login: 'claude auth login' },
  { kind: 'codex', name: 'Codex', login: 'codex login' },
  { kind: 'devin', name: 'Devin', login: 'devin auth login' },
] as const
const KIND_NAMES: Record<WorkerKind, string> = { get dsh() { return t('settings.kind.dsh') }, claude: 'Claude', codex: 'Codex', devin: 'Devin' }
const defaultName = (kind: WorkerKind, model: string, catalog: Catalog | null | undefined, profiles: WorkerInfo[]) => {
  if (kind === 'dsh') return catalog?.groups.flatMap((g) => g.models).find((m) => m.id === model)?.name ?? model
  if (kind === 'devin') return 'Devin'
  return `${KIND_NAMES[kind]} ${model}`
}

type SaveState = { kind: 'idle' | 'saving' } | { kind: 'saved'; text?: string } | { kind: 'error'; text: string }

type LoadState = { kind: 'loading' } | { kind: 'no_repo' } | { kind: 'error'; text: string } | { kind: 'ready'; info: RegistryInfo }

/**
 * Drag state for one ordered list. While `live` the row follows the pointer and its neighbours
 * translate aside to show the landing slot; after release `live` flips off and the same transform
 * eases the row into place — neighbours are already committed to their new positions by then.
 * `from`/`over` are indexes in the order currently rendered.
 */
type OrdFx = { id: string; from: number; over: number; dy: number; rowH: number; live: boolean }

type WorkerOrderProps = {
  cls: { id: TaskClass; label: string }
  list: string[]
  disabled: Record<string, string>
  pool: WorkerInfo[]
  nameOf(id: string): { label: string; badge: string }
  onList(list: string[]): void
}

function WorkerOrder({ cls, list, disabled, pool, nameOf, onList }: WorkerOrderProps) {
  const [fx, setFx] = useState<OrdFx | null>(null)
  const [grab, setGrab] = useState<{ id: string; orig: string[] } | null>(null)
  const [note, setNote] = useState('')
  const listRef = useRef<HTMLOListElement | null>(null)
  const unbind = useRef<(() => void) | null>(null)

  useEffect(() => () => unbind.current?.(), [])

  const moveTo = (from: number, to: number) => {
    if (from === to || to < 0 || to >= list.length) return
    const next = [...list]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x)
    onList(next)
  }

  const settle = (next: OrdFx | null) => {
    setFx(next)
    if (next) {
      // Frame 1: residual offset with transitions on; frame 2: glide to 0; then clear.
      setTimeout(() => setFx((f) => (f && !f.live ? { ...f, dy: 0 } : f)), 20)
      setTimeout(() => setFx(null), SETTLE_MS + 40)
    }
  }

  const beginDrag = (e: ReactPointerEvent<HTMLLIElement>, id: string, index: number) => {
    if (e.button > 0) return // only the primary button starts a drag
    const targetEl = e.target as HTMLElement
    if (targetEl.closest('select, input, .orc-step')) return
    // On touch the row stays scrollable; only the grip is a drag surface there.
    if (e.pointerType === 'touch' && !targetEl.closest('.orc-grip')) return
    const listEl = listRef.current
    if (!listEl) return
    const rowH = (listEl.children[index] as HTMLElement | undefined)?.getBoundingClientRect().height || 26
    const top = listEl.getBoundingClientRect().top
    const startY = e.clientY
    const st = { active: false, over: index, dy: 0 }
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      if (!st.active && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      if (!st.active) window.getSelection()?.removeAllRanges()
      st.active = true
      st.over = Math.max(0, Math.min(list.length - 1, Math.floor((ev.clientY - top) / rowH)))
      st.dy = Math.max(-index * rowH, Math.min((list.length - 1 - index) * rowH, dy))
      setFx({ id, from: index, over: st.over, dy: st.dy, rowH, live: true })
    }
    const stop = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      unbind.current = null
    }
    const onUp = () => {
      stop()
      if (!st.active) {
        setFx(null)
        return
      }
      const target = st.over
      // Commit first, then ease the residual offset away: the neighbour shift is already the
      // final order, so the drop needs no insertion line and no list jump.
      if (target !== index) moveTo(index, target)
      const residual = st.dy - (target - index) * rowH
      setNote(t('settings.position', { label: nameOf(id).label, position: target + 1, count: list.length }))
      settle({ id, from: target, over: target, dy: residual, rowH, live: false })
    }
    const onCancel = () => {
      stop()
      if (st.active) settle({ id, from: index, over: index, dy: 0, rowH, live: false })
      else setFx(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    unbind.current = stop
  }

  /** Keyboard counterpart of the grip: Space/Enter lifts, arrows move, Space/Enter drops, Esc restores. */
  const gripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    const label = nameOf(id).label
    const i = list.indexOf(id)
    if (!grab) {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        setGrab({ id, orig: [...list] })
        setNote(t('settings.grabbing', { label, position: i + 1, count: list.length }))
      }
      return
    }
    if (grab.id !== id) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const to = i + (e.key === 'ArrowUp' ? -1 : 1)
      if (to < 0 || to >= list.length) return
      moveTo(i, to)
      setNote(t('settings.position', { label, position: to + 1, count: list.length }))
    } else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      setGrab(null)
      setNote(t('settings.position', { label, position: list.indexOf(id) + 1, count: list.length }))
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onList(grab.orig)
      setGrab(null)
      setNote(t('settings.cancelMove', { label }))
    }
  }

  /** translateY for row i under the current fx; neighbours step aside, never an insertion line. */
  const rowShift = (i: number): number | undefined => {
    if (!fx) return undefined
    if (i === fx.from) return fx.dy
    if (fx.from < fx.over && i > fx.from && i <= fx.over) return -fx.rowH
    if (fx.over < fx.from && i >= fx.over && i < fx.from) return fx.rowH
    return undefined
  }

  return (
    <section className="orc-class" aria-label={CLASS_LABEL[cls.id]}>
      <h3 className="orc-class__name">{CLASS_LABEL[cls.id]}</h3>
      {list.length === 0 ? <p className="orc-meta">{t('settings.emptyClass')}</p> : null}
      <ol className={`orc-ord${fx?.live ? ' orc-ord--live' : ''}`} ref={listRef}>
        {list.map((id, i) => {
          const { label, badge } = nameOf(id)
          const reason = disabled[id]
          const grabbed = grab?.id === id || fx?.id === id
          const shift = rowShift(i)
          return (
            <li
              key={id}
              className={`orc-ord__row${reason !== undefined ? ' orc-ord__row--off' : ''}${grabbed ? ' orc-ord__row--grab' : ''}${fx && !(fx.live && i === fx.from) ? ' orc-ord__row--mv' : ''}`}
              style={shift ? { transform: `translateY(${shift}px)` } : undefined}
              onPointerDown={(e) => beginDrag(e, id, i)}
            >
              <span className="orc-ord__n" aria-hidden="true">
                {i + 1}
              </span>
              <button
                type="button"
                className="orc-grip"
                aria-label={t('settings.reorder', { label })}
                aria-pressed={grab?.id === id}
                title={t('settings.gripHint')}
                onKeyDown={(e) => gripKey(e, id)}
              >
                <span className="orc-grip__dots" aria-hidden="true" />
              </button>
              <span className="orc-wk" aria-hidden="true">
                {badge}
              </span>
              <span className="orc-ord__name" title={label !== id ? id : undefined}>
                {label}
              </span>
              {reason !== undefined ? <span className="orc-ord__off">{t('settings.off')}{reason ? ` — ${reason === OFF_REASON ? t('settings.offReason') : reason}` : ''}</span> : null}
              <span className="orc-ord__btns">
                <button type="button" className="orc-step" aria-label={t('settings.raise', { id })} disabled={i === 0} onClick={() => moveTo(i, i - 1)}>
                  ↑
                </button>
                <button type="button" className="orc-step" aria-label={t('settings.lower', { id })} disabled={i === list.length - 1} onClick={() => moveTo(i, i + 1)}>
                  ↓
                </button>
                <button type="button" className="orc-step" aria-label={t('settings.removeFromClass', { id })} onClick={() => onList(list.filter((x) => x !== id))}>
                  ×
                </button>
              </span>
            </li>
          )
        })}
      </ol>
      <select
        className="orc-select orc-class__add"
        aria-label={t('settings.addToClass', { label: CLASS_LABEL[cls.id] })}
        value=""
        disabled={pool.length === 0}
        onChange={(e) => {
          if (e.target.value) onList([...list, e.target.value])
        }}
      >
        <option value="">{t('settings.addWorkerOption')}</option>
        {pool.map((w) => (
          <option key={w.id} value={w.id}>
            {w.label}
          </option>
        ))}
      </select>
      <span className="orc-sr-only" role="status">
        {note}
      </span>
    </section>
  )
}

/**
 * the routing document lives in the Orchestra profile store, shared with the CLI and `orch run`.
 */
export function OrchestraSettings() {
  useLang()
  ensureStyles()
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [presets, setPresets] = useState<WorkerPreset[]>([])
  const [snapshot, setSnapshot] = useState<OrchestraSnapshot | null>(null)
  const [presetEdit, setPresetEdit] = useState<string | null>(null)
  const [presetName, setPresetName] = useState('')
  const [newPresetName, setNewPresetName] = useState('')
  const [creatingPreset, setCreatingPreset] = useState(false)
  const [presetDelete, setPresetDelete] = useState<string | null>(null)
  const [presetBusy, setPresetBusy] = useState(false)
  const [routing, setRouting] = useState<Routing | null>(null)
  const [save, setSave] = useState<SaveState>({ kind: 'idle' })
  const [showExtra, setShowExtra] = useState(false)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<WorkerKind>('dsh')
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('')
  const [labelEdited, setLabelEdited] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ id: string; field: 'label' | 'note'; value: string } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [access, setAccess] = useState<Partial<Record<WorkerKind, AccessResult | 'checking' | 'error'>>>({})
  const [formAccess, setFormAccess] = useState<AccessResult | 'checking' | 'error' | null>(null)
  const repoRef = useRef<string | null>(null)
  const savedRef = useRef<Routing | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const queued = useRef<Routing | null>(null)
  const inFlight = useRef(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const state = await api.state().catch(() => null)
      if (!alive) return
      if (!state?.ok) {
        setLoad({ kind: 'error', text: t('settings.loadError') })
        return
      }
      const root = state.value.repos[0]?.root
      if (!root) {
        setLoad({ kind: 'no_repo' })
        return
      }
      setSnapshot(state.value)
      const presetResult = await api.presets(root).catch(() => null)
      if (presetResult?.ok && Array.isArray(presetResult.value?.presets)) setPresets(presetResult.value.presets)
      const workers = await api.workers(root).catch(() => null)
      if (!alive) return
      if (!workers?.ok) {
        setLoad({ kind: 'error', text: workers ? describeApiError(workers.error, workers.message) : t('settings.loadError') })
        return
      }
      repoRef.current = root
      savedRef.current = workers.value.routing
      setRouting(workers.value.routing)
      setPresets((old) => [{ id: 'all-workers', label: 'All workers', routing: workers.value.routing.classes, builtin: true }, ...old.filter((p) => p.id !== 'all-workers')])
      setLoad({ kind: 'ready', info: workers.value })
    })()
    return () => {
      alive = false
      if (timer.current) clearTimeout(timer.current)
      // An edit made in the debounce window still lands when the section is closed.
      const pending = queued.current
      const repo = repoRef.current
      if (pending && repo) void api.saveWorkers(repo, pending).catch(() => {})
    }
  }, [])

  /** Saves run in order and never in parallel: an older document must not overwrite a newer one. */
  const flush = async () => {
    const repo = repoRef.current
    const next = queued.current
    if (!repo || !next || inFlight.current) return
    queued.current = null
    inFlight.current = true
    const result: ApiResult<null> = await api.saveWorkers(repo, next).catch(() => ({ ok: false, error: 'network' }))
    inFlight.current = false
    if (result.ok) {
      savedRef.current = next
      setSave({ kind: queued.current ? 'saving' : 'saved' })
    } else {
      setSave({ kind: 'error', text: describeApiError(result.error, result.message) })
      // A failed save leaves the document unchanged on disk — roll the editor back to match it.
      if (!queued.current && savedRef.current) setRouting(savedRef.current)
    }
    if (queued.current) await flush()
  }

  const change = (next: Routing) => {
    setRouting(next)
    queued.current = next
    setSave({ kind: 'saving' })
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS)
  }

  const postWorker = async <T,>(route: string, body: Record<string, unknown>): Promise<ApiResult<T>> => {
    const response = await fetch(`/crewboard/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orchestra-client': '1' },
      body: JSON.stringify({ repo: repoRef.current, ...body }),
    })
    return response.json() as Promise<ApiResult<T>>
  }

  const refreshWorkers = async () => {
    const repo = repoRef.current
    if (!repo) return
    const result = await api.workers(repo)
    if (!result.ok) throw new Error(describeApiError(result.error, result.message))
    setLoad({ kind: 'ready', info: result.value })
    setRouting(result.value.routing)
    savedRef.current = result.value.routing
  }

  const saveEntry = async (entry: WorkerEntry) => {
    setSave({ kind: 'saving' })
    try {
      const result = await postWorker('worker-save', { entry })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      await refreshWorkers()
      setAdding(false)
      setEdit(null)
      setMenuId(null)
      setSave({ kind: 'saved' })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.saveWorkerError') })
    }
  }

  const removeEntry = async (id: string) => {
    setSave({ kind: 'saving' })
    try {
      const result = await postWorker<{ removed: string[] }>('worker-delete', { id })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      setDeleteId(null)
      setMenuId(null)
      await refreshWorkers()
      setSave({ kind: 'saved', text: t('settings.workerRemoved', { workers: result.value.removed.join(', ') }) })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.removeWorkerError') })
    }
  }

  const checkAccess = async (target: WorkerKind, targetModel = '', forForm = false) => {
    if (forForm) setFormAccess('checking')
    else setAccess((prev) => ({ ...prev, [target]: 'checking' }))
    try {
      const result = await postWorker<AccessResult>('worker-check', { kind: target, model: targetModel })
      const value = result.ok && result.value && Array.isArray(result.value.checks) ? result.value : 'error'
      if (forForm) setFormAccess(value)
      else setAccess((prev) => ({ ...prev, [target]: value }))
    } catch {
      if (forForm) setFormAccess('error')
      else setAccess((prev) => ({ ...prev, [target]: 'error' }))
    }
  }

  if (load.kind === 'loading') return <div className="orc-settings"><p className="orc-set__empty">{t('settings.loading')}</p></div>
  if (load.kind === 'no_repo') {
    return (
      <div className="orc-settings">
        <p className="orc-set__empty">{t('settings.noRepos')}</p>
      </div>
    )
  }
  if (load.kind === 'error' || !routing) return <div className="orc-settings"><p className="orc-error">{load.kind === 'error' ? load.text : ''}</p></div>

  const { classes } = load.info
  const registry = load.info.registry ?? []
  // Registry names are owner edits; the host may otherwise replace them with saved alias labels.
  const all = load.info.workers.map((worker) => {
    const entry = registry.find((item) => item.id === worker.id)
    return entry ? { ...worker, label: entry.label, billing: entry.billing } : worker
  })
  const catalog = load.info.catalog
  // The dsh runner currently selects through deepseek-official; other catalog providers cannot launch here.
  const deepSeekGroups = catalog?.groups.filter((group) => group.id === 'deepseek-official') ?? []
  const catalogModels = deepSeekGroups.flatMap((group) => group.models)
  const profiles = all.filter((w) => !registry.some((entry) => entry.id === w.id))
  const main = all.filter((w) => w.main)
  const extras = all
    .filter((w) => !w.main)
    .sort((a, b) => PROVIDER_ORDER.indexOf(a.provider) - PROVIDER_ORDER.indexOf(b.provider) || a.label.localeCompare(b.label, 'ru'))
  const byProvider = (list: WorkerInfo[]) =>
    PROVIDER_ORDER.map((provider) => ({ provider, list: list.filter((w) => w.provider === provider) })).filter((g) => g.list.length > 0)

  const usedIn = (id: string): string => {
    const hits: string[] = []
    for (const cls of classes) {
      routing.classes[cls.id].forEach((entry, i) => {
        if ((PROFILE_ALIASES[entry] ?? entry) === id) hits.push(t('settings.usedPosition', { class: CLASS_SHORT[cls.id], position: i + 1 }))
      })
    }
    return hits.length ? hits.join(' · ') : t('settings.notUsed')
  }

  /** Display name and badge for a routing entry: a saved alias resolves to its folded direct row. */
  const byId = new Map(all.map((w) => [w.id, w]))
  const nameOf = (id: string): { label: string; badge: string } => {
    const w = byId.get(PROFILE_ALIASES[id] ?? id)
    return { label: w?.label ?? id, badge: agentBadge(w?.id ?? id) }
  }

  const toggle = (id: string, off: boolean) => {
    const disabled = { ...routing.disabled }
    if (off) disabled[id] = OFF_REASON
    else delete disabled[id]
    change({ ...routing, disabled })
  }
  const setList = (cls: TaskClass, list: string[]) => change({ ...routing, classes: { ...routing.classes, [cls]: list } })

  const savePreset = async (preset: WorkerPreset) => {
    if (!repoRef.current || presetBusy) return
    setPresetBusy(true)
    try {
      const result = await api.savePreset(repoRef.current, preset)
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      setPresets((old) => [...old.filter((p) => p.builtin), ...result.value])
      setPresetEdit(preset.id)
      setPresetName('')
      setNewPresetName('')
      setSave({ kind: 'saved' })
    } catch (error) { setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.loadError') }) }
    finally { setPresetBusy(false) }
  }
  const presetUses = (id: string) => snapshot?.repos.flatMap((repo) => [
    ...(repo.effectiveRouting?.source !== 'plan' && repo.effectiveRouting?.preset.id === id ? [t('settings.presetRepoUse', { repo: repo.root.split('/').filter(Boolean).at(-1) ?? repo.root })] : []),
    ...(repo.plans ?? []).filter((plan) => plan.effectiveRouting?.source === 'plan' && plan.effectiveRouting.preset.id === id).map((plan) => t('settings.presetPlanUse', { repo: repo.root.split('/').filter(Boolean).at(-1) ?? repo.root, plan: plan.goal })),
  ]) ?? []
  const removePreset = async (id: string) => {
    if (!repoRef.current || presetBusy) return
    setPresetBusy(true)
    try {
      const result = await api.deletePreset(repoRef.current, id)
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      setPresets((old) => old.filter((p) => p.id !== id))
      setPresetDelete(null)
      if (presetEdit === id) setPresetEdit(null)
      setSave({ kind: 'saved' })
    } catch (error) { setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.loadError') }) }
    finally { setPresetBusy(false) }
  }
  const assignable = all.filter((w) => w.main || (showExtra && routing.disabled[w.id] === undefined))

  const workerRow = (w: WorkerInfo) => {
    const reason = routing.disabled[w.id]
    const off = reason !== undefined
    const entry = registry.find((item) => item.id === w.id)
    const uses = usedIn(w.id)
    return (
      <li key={w.id} className={`orc-wrow${off ? ' orc-wrow--off' : ''}`}>
        <div className="orc-wrow__line">
          <span className="orc-wrow__who">
            <span className="orc-wk" aria-hidden="true">
              {agentBadge(w.id)}
            </span>
            <span className="orc-wrow__name">
              <span className="orc-wrow__label">{w.label}</span>
              {w.label !== w.id ? <span className="orc-wrow__id">{w.id}</span> : null}
            </span>
          </span>
          <span className="orc-wrow__bill">{w.billing === '\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0430' ? t('settings.billing.subscription') : w.billing === '\u043f\u0440\u043e\u043c\u043e' ? t('settings.billing.promo') : w.billing}</span>
          <span className="orc-wrow__use">{usedIn(w.id)}</span>
          <button
            type="button"
            role="switch"
            aria-checked={!off}
            aria-label={t('settings.workerAria', { id: w.id })}
            className="orc-switch"
            onClick={() => toggle(w.id, !off)}
          />
          <button type="button" className="orc-wrow__menu-button" aria-label={t('settings.actions', { label: w.label })} aria-expanded={menuId === w.id}
            onClick={() => { setMenuId(menuId === w.id ? null : w.id); setEdit(null); setDeleteId(null) }}>···</button>
        </div>
        {entry?.note ? <p className="orc-wrow__note">{entry.note}</p> : null}
        {menuId === w.id ? <div className="orc-wrow__actions">
          <button type="button" onClick={() => setEdit({ id: w.id, field: 'label', value: entry?.label ?? w.label })}>{t('settings.rename')}</button>
          <button type="button" onClick={() => setEdit({ id: w.id, field: 'note', value: entry?.note ?? '' })}>{t('settings.note')}</button>
          <button type="button" onClick={() => setDeleteId(w.id)}>{t('settings.remove')}</button>
        </div> : null}
        {edit?.id === w.id ? <form className="orc-wrow__edit" onSubmit={(event) => {
          event.preventDefault()
          if (!entry) { setSave({ kind: 'error', text: t('settings.profileEdit') }); return }
          void saveEntry({ ...entry, [edit.field]: edit.value.trim() })
        }}>
          <label>{edit.field === 'label' ? t('settings.newName') : t('settings.note')}{/* biome-ignore lint/a11y/noAutofocus: Focus moves to this field when its dialog opens. */} <input className="orc-input" autoFocus value={edit.value} onChange={(event) => setEdit({ ...edit, value: event.target.value })} /></label>
          <button type="submit" disabled={!entry || (edit.field === 'label' && !edit.value.trim())}>{t('settings.save')}</button>
          <button type="button" onClick={() => setEdit(null)}>{t('settings.cancel')}</button>
          {!entry ? <span className="orc-hint">{t('settings.profileEditHint')}</span> : null}
        </form> : null}
        {deleteId === w.id ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-wrow__confirm" role="group" aria-label={t('settings.deleteAria', { label: w.label })}>
          <span>{entry ? (uses === t('settings.notUsed') ? t('settings.removePrompt', { label: w.label }) : t('settings.removeUsedPrompt', { label: w.label, uses })) : t('settings.profileDelete')}</span>
          {entry ? <button type="button" className="orc-danger" onClick={() => void removeEntry(w.id)}>{t('settings.removeWorker')}</button> : null}
          <button type="button" onClick={() => setDeleteId(null)}>{t('settings.cancel')}</button>
        </div> : null}
        {off ? (
          <input
            className="orc-input orc-wrow__reason"
            aria-label={t('settings.disableReason', { id: w.id })}
            placeholder={t('settings.offReason')}
            value={reason}
            onChange={(e) => change({ ...routing, disabled: { ...routing.disabled, [w.id]: e.target.value } })}
          />
        ) : null}
      </li>
    )
  }

  return (
    <div className="orc-settings">
      <section className="orc-block">
        <h2 className="orc-block__head">
          <span>{t('settings.workers')}</span>
          <span className="orc-col__count">{main.length}</span>
        </h2>
        <p className="orc-hint">{t('settings.workersHint')}</p>
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: This label describes a styled presentation region or indicator. */} <div className="orc-family" aria-label={t('settings.cliAccess')}>
          {CLI_FAMILIES.map((family) => {
            const result = access[family.kind]
            const binary = typeof result === 'object' ? result.checks.find((check) => check.name === 'binary') : undefined
            const auth = typeof result === 'object' ? result.checks.find((check) => check.name === 'auth') : undefined
            const status = result === 'checking' ? t('settings.checking') : result === 'error' ? t('settings.checkError') : !result ? t('settings.unchecked') : binary && !binary.ok ? t('settings.cliMissing') : auth ? (auth.ok ? t('settings.signedIn') : t('settings.signinNeeded')) : t('settings.cliUnconfirmed')
            return <div className="orc-family__item" key={family.kind}>
              <span className="orc-family__name">{family.name}</span>
              <span className="orc-family__state">{status}</span>
              <code title={family.login}>{family.login}</code>
              <button type="button" disabled={result === 'checking'} onClick={() => void checkAccess(family.kind)}>{t('settings.checkAccess')}</button>
            </div>
          })}
        </div>
        <div className="orc-wcap" aria-hidden="true">
          <span />
          <span>{t('settings.billing')}</span>
          <span>{t('settings.usedIn')}</span>
          <span className="orc-wcap__sw">{t('settings.assign')}</span>
        </div>
        {byProvider(main).map((g) => (
          <section key={g.provider} className="orc-wgroup" aria-label={g.provider === '\u0414\u0440\u0443\u0433\u0438\u0435' ? t('settings.providerOther') : g.provider}>
            <h3 className="orc-wgroup__name">{g.provider === '\u0414\u0440\u0443\u0433\u0438\u0435' ? t('settings.providerOther') : g.provider}</h3>
            <ul className="orc-set__list">{g.list.map(workerRow)}</ul>
          </section>
        ))}
        {extras.length > 0 ? (
          <div className="orc-extra">
            <button type="button" className="orc-disclose" aria-expanded={showExtra} onClick={() => setShowExtra((v) => !v)}>
              <span className="orc-disclose__mark" aria-hidden="true">
                ▸
              </span>
              {t('settings.extraCount', { count: extras.length })}
            </button>
            {showExtra ? (
              <div className="orc-extra__body">
                <p className="orc-hint">
                  {t('settings.extraHint')}
                </p>
                {byProvider(extras).map((g) => (
                  <section key={g.provider} className="orc-wgroup" aria-label={g.provider === '\u0414\u0440\u0443\u0433\u0438\u0435' ? t('settings.providerOther') : g.provider}>
                    <h3 className="orc-wgroup__name">{g.provider === '\u0414\u0440\u0443\u0433\u0438\u0435' ? t('settings.providerOther') : g.provider}</h3>
                    <ul className="orc-set__list">{g.list.map(workerRow)}</ul>
                  </section>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="orc-add">
          <button type="button" className="orc-add__trigger" aria-expanded={adding} onClick={() => { setAdding(!adding); setFormAccess(null) }}>{t('settings.addWorker')}</button>
          {adding ? <form className="orc-add__form" onSubmit={(event) => {
            event.preventDefault()
            const value = model.trim()
            if (!label.trim() || (kind !== 'devin' && !value)) return
            const id = kind === 'devin' ? 'devin' : `${kind}/${value}`
            void saveEntry({ id, kind, ...(kind === 'claude' || kind === 'codex' || kind === 'dsh' ? { model: value } : {}), label: label.trim(), billing: kind === 'dsh' ? 'API' : kind === 'devin' ? '\u043f\u0440\u043e\u043c\u043e' : '\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0430' })
          }}>
            <label>{t('settings.workerType')}<select className="orc-select" value={kind} onChange={(event) => { const next = event.target.value as WorkerKind; setKind(next); setModel(''); setLabel(defaultName(next, '', catalog, profiles)); setLabelEdited(false); setFormAccess(null) }}>
              {(Object.keys(KIND_NAMES) as WorkerKind[]).map((item) => <option key={item} value={item}>{KIND_NAMES[item]}</option>)}
            </select></label>
            {kind === 'dsh' ? <label>{t('settings.dshModel')}<select className="orc-select" aria-label={t('settings.modelDsh')} value={model} disabled={catalogModels.length === 0} onChange={(event) => { setModel(event.target.value); if (!labelEdited) setLabel(defaultName(kind, event.target.value, catalog, profiles)) }}>
              <option value="">{t('settings.chooseModel')}</option>{deepSeekGroups.map((group) => <optgroup key={group.id} label={group.name}>{group.models.map((item) => <option key={`${group.id}/${item.id}`} value={item.id}>{item.name} · {group.name}</option>)}</optgroup>)}
            </select>{catalogModels.length === 0 ? <span className="orc-hint">{t('settings.configureModels')}</span> : null}</label> : null}
            {kind === 'claude' || kind === 'codex' ? <label>{t('settings.modelId')}<input className="orc-input" value={model} placeholder={kind === 'claude' ? t('settings.modelExampleClaude') : t('settings.modelExampleCodex')} onChange={(event) => { setModel(event.target.value); if (!labelEdited) setLabel(defaultName(kind, event.target.value, catalog, profiles)); setFormAccess(null) }} /></label> : null}
            {kind === 'devin' ? <p className="orc-hint">{t('settings.devinModelHint')}</p> : null}
            {(kind === 'claude' || kind === 'codex' || kind === 'devin') ? <div className="orc-add__check"><button type="button" disabled={formAccess === 'checking'} onClick={() => void checkAccess(kind, model, true)}>{t('settings.check')}</button><span role="status">{formAccess === 'checking' ? t('settings.checkForm') : formAccess === 'error' ? t('settings.checkFormError') : formAccess ? (formAccess.ok ? t('settings.cliAvailable') : formAccess.checks.filter((check) => !check.ok).map((check) => `${check.detail}${check.fix ? ` · ${check.fix}` : ''}`).join('; ')) : t('settings.checkManual')}</span></div> : null}
            <label>{t('settings.workerName')}<input className="orc-input" value={label} onChange={(event) => { setLabel(event.target.value); setLabelEdited(true) }} /></label>
            <div className="orc-add__buttons"><button type="submit" disabled={!label.trim() || (kind !== 'devin' && !model.trim()) || (kind === 'dsh' && !catalogModels.some((item) => item.id === model))}>{t('settings.add')}</button><button type="button" onClick={() => setAdding(false)}>{t('settings.cancel')}</button></div>
          </form> : null}
        </div>
      </section>

      <section className="orc-block" aria-label={t('settings.presets')}>
        <h2 className="orc-block__head">{t('settings.presets')}</h2>
        <p className="orc-hint">{t('settings.presetsHint')}</p>
        <ul className="orc-set__list">
          {presets.map((preset) => <li key={preset.id} className="orc-preset-row">
            <div className="orc-preset-row__line">
              <span className="orc-wrow__name"><span className="orc-wrow__label">{preset.builtin ? t('settings.allWorkers') : preset.label}</span></span>
              <span className="orc-preset-row__use">{preset.builtin ? t('settings.defaultPreset') : presetUses(preset.id).join(', ') || t('settings.notUsed')}</span>
              <span className="orc-wrow__actions">
                <button type="button" onClick={() => { setPresetEdit(presetEdit === preset.id ? null : preset.id); setPresetName('') }}>{t('settings.edit')}</button>
                {!preset.builtin ? <button type="button" onClick={() => { setPresetDelete(preset.id); setPresetEdit(null) }}>{t('settings.remove')}</button> : null}
              </span>
            </div>
            {presetEdit === preset.id ? <fieldset className="orc-preset__edit" disabled={presetBusy}>
              {!preset.builtin ? <form className="orc-wrow__edit" onSubmit={(e) => { e.preventDefault(); if (presetName.trim()) void savePreset({ ...preset, label: presetName.trim() }) }}>
                <label>{t('settings.newName')}<input className="orc-input" value={presetName} placeholder={preset.label} onChange={(e) => setPresetName(e.target.value)} /></label>
                <button type="submit" disabled={presetBusy || !presetName.trim()}>{t('settings.rename')}</button>
              </form> : null}
              {classes.map((cls) => {
                const list = preset.builtin ? routing.classes[cls.id] : preset.routing[cls.id]
                const pool = preset.builtin ? assignable.filter((w) => !list.some((id) => (PROFILE_ALIASES[id] ?? id) === w.id)) : all.filter((w) => !list.includes(w.id))
                return <WorkerOrder key={`${preset.id}-${cls.id}`} cls={cls} list={list} disabled={routing.disabled} pool={pool} nameOf={nameOf} onList={(next) => preset.builtin ? setList(cls.id, next) : void savePreset({ ...preset, routing: { ...preset.routing, [cls.id]: next } })} />
              })}
            </fieldset> : null}
            {presetDelete === preset.id ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-wrow__confirm" role="group" aria-label={t('settings.deleteAria', { label: preset.label })}>
              <span>{t('settings.presetDeletePrompt', { label: preset.label })}</span>
              {presetUses(preset.id).length ? <ul>{presetUses(preset.id).map((use) => <li key={use}>{use}</li>)}</ul> : <span>{t('settings.visibleUses')}</span>}
              <button type="button" className="orc-danger" disabled={presetBusy} onClick={() => void removePreset(preset.id)}>{t('settings.remove')}</button>
              <button type="button" onClick={() => setPresetDelete(null)}>{t('settings.cancel')}</button>
            </div> : null}
          </li>)}
        </ul>
        {!creatingPreset ? <button type="button" className="orc-preset-row__new" onClick={() => setCreatingPreset(true)}>{t('settings.newPreset')}</button> : <form className="orc-wrow__edit orc-preset-row__new-form" onSubmit={(e) => { e.preventDefault(); const name = newPresetName.trim(); if (!name) return; const id = `preset-${Math.random().toString(36).slice(2, 10)}`; void savePreset({ id, label: name, routing: structuredClone(routing.classes) }); setCreatingPreset(false) }}>
          <label>{t('settings.presetName')}<input className="orc-input" value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} /></label>
          <button type="submit" disabled={!newPresetName.trim() || presetBusy}>{t('settings.createPreset')}</button>
          <button type="button" onClick={() => setCreatingPreset(false)}>{t('settings.cancel')}</button>
        </form>}
      </section>

      <NotifySettings />

      <section className="orc-set__section"><button type="button" onClick={() => { try { globalThis.localStorage?.removeItem(TOUR_KEY) } catch { /* optional storage */ } if (repoRef.current) void api.exampleCreate(repoRef.current, getLang()).then((result) => { if (result.ok) { selectMainPanel(PANEL_ID); window.dispatchEvent(new Event('orchestra:show-introduction')) } }) }}>{t('welcome.showAgain')}</button></section>
      <WorktreeSettings repo={repoRef.current!} />

      <p className={`orc-set__status${save.kind === 'error' ? ' orc-set__status--err' : ''}`} role="status">
        {save.kind === 'saving' ? t('settings.saving') : save.kind === 'saved' ? save.text ?? t('settings.saved') : save.kind === 'error' ? save.text : ''}
      </p>
    </div>
  )
}
