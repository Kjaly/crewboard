import { getLang, t, useLang } from './i18n.js'
import { CLASS_LABEL } from './routing.js'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { PROFILE_ALIASES, entryEffort, workerLabel, type Routing, type SubscriptionCli, type TaskClass, type Transport, type WorkerInfo, type WorkersInfo, type WorkerPreset, type OrchestraSnapshot } from '../shared/types.js'
import { openDshModels } from './dsh-settings-link.js'
import { NotifySettings } from './notify-settings.js'
import { describeApiError } from './actions.js'
import { type ApiResult, api, shared } from './api.js'
import { agentBadge } from './insight.js'
import { ensureStyles } from './styles.js'
import { PANEL_ID } from '../shared/types.js'
import { selectMainPanel } from './layout.js'
import { TOUR_KEY } from './tour.js'
import { WorktreeSettings } from './worktree-settings.js'
import { hostEvents } from './host-events.js'

/** Default reason when a worker is switched off — matches `orch workers disable`. */
const OFF_REASON = '\u043d\u0435\u0442 \u043b\u0438\u043c\u0438\u0442\u043e\u0432'
const SAVE_DELAY_MS = 300
/** A pointer has to travel this far before a row press becomes a drag — clicks stay clicks. */
const DRAG_THRESHOLD_PX = 4
const SETTLE_MS = 180

const CLASS_SHORT: Record<TaskClass, string> = { get code() { return t('settings.classShort.code') }, get design() { return t('settings.classShort.design') }, get review() { return t('settings.classShort.review') }, get research() { return t('settings.classShort.research') } }
type WorkerKind = 'dsh' | 'claude' | 'codex' | 'devin' | 'opencode' | 'cursor' | 'gemini' | 'grok'
type WorkerEntry = { id: string; kind: WorkerKind; model?: string; label: string; effort?: string; billing: 'API' | '\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0430' | '\u043f\u0440\u043e\u043c\u043e'; note?: string }
type Catalog = { groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; failures: Array<{ id: string; name: string; message: string }> }
type RegistryInfo = WorkersInfo & { registry?: WorkerEntry[]; catalog?: Catalog | null }
type AccessResult = { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> }
type SubscriptionKind = 'claude' | 'codex' | 'devin' | 'opencode' | 'cursor' | 'gemini' | 'grok'
type SubscriptionModel = { model: string; label: string; efforts: string[]; defaultEffort?: string }
/** «Add models» for one signed-in CLI (pv1): its models, and what the person ticked. */
type ModelPick =
  | { kind: SubscriptionKind; state: 'loading' }
  | { kind: SubscriptionKind; state: 'error'; text: string }
  | { kind: SubscriptionKind; state: 'ready'; source: 'builtin' | 'cli'; models: SubscriptionModel[]; chosen: string[]; efforts: string[] }
/**
 * wo2: which provider blocks this viewer opened or folded, by block key (`cli:claude`, `dsh:OpenRouter`). Storage
 * is a convenience: without it every block takes its default — open when its models are used, else folded.
 */
const PROVIDERS_OPEN_KEY = 'crewboard:settings:providers-open'
const readProvidersOpen = (): Record<string, boolean> => {
  try {
    const value: unknown = JSON.parse(globalThis.localStorage?.getItem(PROVIDERS_OPEN_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, boolean] => typeof pair[1] === 'boolean'))
  } catch { return {} }
}
const writeProvidersOpen = (open: Record<string, boolean>): void => {
  try { globalThis.localStorage?.setItem(PROVIDERS_OPEN_KEY, JSON.stringify(open)) } catch { /* optional storage */ }
}
/** What in a snapshot's worker list says dsh's catalog changed: the dsh rows, their names and whether they are missing. */
const dshSignature = (workers: readonly WorkerInfo[] | undefined): string =>
  (workers ?? []).filter((w) => w.dsh).map((w) => `${w.id}\u0000${w.label}\u0000${w.dsh?.missing ? 1 : 0}`).join('\n')
/**
 * The subscription CLI blocks (wo1). Claude, Codex and Devin always show — a new person checks access there; a
 * CLI an older tool's profile runs on (OpenCode, Cursor Agent, Gemini CLI, Grok CLI) shows once one of its
 * workers is in use. Whether Crewboard runs tasks on a CLI is the host's to say (`runnableClis`, wo2), never
 * this table's — rb1 gives every one of them a runner, so the note survives only for a CLI added without one.
 */
const CLI_INFO: Record<SubscriptionCli, { name: string; login?: string }> = {
  claude: { name: 'Claude', login: 'claude auth login' },
  codex: { name: 'Codex', login: 'codex login' },
  devin: { name: 'Devin', login: 'devin auth login' },
  opencode: { name: 'OpenCode', login: 'opencode auth login' },
  cursor: { name: 'Cursor Agent', login: 'cursor-agent login' },
  // Gemini CLI has no login subcommand upstream — signing in happens inside `gemini` (or via GEMINI_API_KEY).
  gemini: { name: 'Gemini CLI', login: 'gemini' },
  grok: { name: 'Grok CLI', login: 'grok login' },
}
const BASE_CLIS: SubscriptionCli[] = ['claude', 'codex', 'devin']
const SUBSCRIPTION_CLIS_EXTRA: SubscriptionCli[] = ['opencode', 'cursor', 'gemini', 'grok']
const TRANSPORT_NAME: Partial<Record<Transport, string>> = { dsh: 'dsh', 'claude-cli': 'Claude', 'codex-cli': 'Codex', 'devin-acp': 'Devin', opencode: 'OpenCode', 'cursor-agent': 'Cursor Agent', 'gemini-cli': 'Gemini CLI', 'grok-build': 'Grok CLI' }
// rb1: every subscription CLI Crewboard discovers now has a runner and a models list, so every one is pickable.
const isPickable = (_cli: SubscriptionCli): _cli is SubscriptionKind => true
/** wo2: a worker Crewboard can launch — the host says `runs: false` for one of a CLI without a runner backend. */
const runs = (w: WorkerInfo): boolean => w.runs !== false
/** The section a worker is listed in; a host without wo1 placement only knows dsh rows apart. */
const sectionOf = (w: WorkerInfo): NonNullable<WorkerInfo['section']> => w.section ?? (w.dsh ? 'dsh' : 'other')
/** A CLI's access, as its last check said. Models show unless the check said the CLI is missing or signed out. */
type CliStatus = 'unchecked' | 'checking' | 'error' | 'missing' | 'signin' | 'signed' | 'unconfirmed'
const cliStatus = (result: AccessResult | 'checking' | 'error' | undefined): CliStatus => {
  if (result === 'checking') return 'checking'
  if (result === 'error') return 'error'
  if (!result) return 'unchecked'
  const binary = result.checks.find((check) => check.name === 'binary')
  const auth = result.checks.find((check) => check.name === 'auth')
  if (binary && !binary.ok) return 'missing'
  if (!auth) return binary ? 'unconfirmed' : 'error'
  // rb1: a CLI whose sign-in the check cannot confirm (Gemini keeps OAuth in the OS keychain) still passes
  // preflight — it must not block a launch — and carries a fix hint; Settings says «unconfirmed», not «signed in».
  return auth.ok ? (auth.fix ? 'unconfirmed' : 'signed') : 'signin'
}
const showsModels = (status: CliStatus): boolean => status !== 'missing' && status !== 'signin'
/** One entry of «Used in»: the preset (the routing is the built-in one) and the class it opens. */
type Use = { preset: string; cls: TaskClass; label: string }
const BUILTIN_PRESET = 'all-workers'
const workerDomId = (id: string) => `orc-worker-${id}`
const cliDomId = (cli: string) => `orc-cli-${cli}`
const classDomId = (preset: string, cls: TaskClass) => `orc-preset-${preset}-${cls}`
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']
/** Workers of one model (transport and model), each effort its own worker, in effort order. */
const modelRows = (list: WorkerInfo[]): WorkerInfo[][] => {
  const rows = new Map<string, WorkerInfo[]>()
  for (const w of list) {
    const key = `${w.transport ?? ''}\u0000${w.dsh ? `${w.dsh.provider}/${w.dsh.model}` : w.model ?? w.id}`
    rows.set(key, [...(rows.get(key) ?? []), w])
  }
  const rank = (w: WorkerInfo) => (w.effort ? EFFORT_ORDER.indexOf(w.effort) : -1)
  return [...rows.values()].map((row) => [...row].sort((a, b) => rank(a) - rank(b)))
}
const KIND_NAMES: Record<WorkerKind, string> = { get dsh() { return t('settings.kind.dsh') }, claude: 'Claude', codex: 'Codex', devin: 'Devin', opencode: 'OpenCode', cursor: 'Cursor Agent', gemini: 'Gemini CLI', grok: 'Grok CLI' }
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
  domId: string
  cls: { id: TaskClass; label: string }
  list: string[]
  disabled: Record<string, string>
  pool: WorkerInfo[]
  nameOf(id: string): { label: string; badge: string }
  /** wo1: an entry this machine cannot run stays listed, marked with why, and links back to the worker. */
  unavailable(id: string): string | undefined
  onShow(id: string): void
  onList(list: string[]): void
}

function WorkerOrder({ domId, cls, list, disabled, pool, nameOf, unavailable, onShow, onList }: WorkerOrderProps) {
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
    if (targetEl.closest('select, input, .orc-step, .orc-ord__na')) return
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
    <section className="orc-class" id={domId} tabIndex={-1} aria-label={CLASS_LABEL[cls.id]}>
      <h3 className="orc-class__name">{CLASS_LABEL[cls.id]}</h3>
      {list.length === 0 ? <p className="orc-meta">{t('settings.emptyClass')}</p> : null}
      <ol className={`orc-ord${fx?.live ? ' orc-ord--live' : ''}`} ref={listRef}>
        {list.map((id, i) => {
          const { label, badge } = nameOf(id)
          const reason = disabled[id] ?? disabled[PROFILE_ALIASES[id] ?? id]
          const grabbed = grab?.id === id || fx?.id === id
          const shift = rowShift(i)
          const na = unavailable(id)
          return (
            <li
              key={id}
              className={`orc-ord__row${na ? ' orc-ord__row--off' : ''}${grabbed ? ' orc-ord__row--grab' : ''}${fx && !(fx.live && i === fx.from) ? ' orc-ord__row--mv' : ''}`}
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
              {na ? <button type="button" className="orc-ord__na" aria-label={t('settings.showWorker', { label })} onClick={() => onShow(id)}>{na}{reason ? ` — ${reason === OFF_REASON ? t('settings.offReason') : reason}` : ''}</button> : null}
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

const FAMILY_NAMES: Record<SubscriptionKind, string> = { claude: 'Claude', codex: 'Codex', devin: 'Devin', opencode: 'OpenCode', cursor: 'Cursor Agent', gemini: 'Gemini CLI', grok: 'Grok CLI' }

type ModelPickerProps = {
  pick: ModelPick
  onPick(next: ModelPick): void
  onAdd(pick: Extract<ModelPick, { state: 'ready' }>): void
  onCancel(): void
}

/** «Add models» (pv1): the signed-in CLI's models and the efforts to add each at — one worker per pair. */
function ModelPicker({ pick, onPick, onAdd, onCancel }: ModelPickerProps) {
  const title = t('settings.addModelsTitle', { name: FAMILY_NAMES[pick.kind] })
  if (pick.state === 'loading') return <p className="orc-hint" role="status">{t('settings.addModelsLoading')}</p>
  if (pick.state === 'error') return <p className="orc-error" role="status">{t('settings.addModelsError', { message: pick.text })}</p>
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value])
  // The efforts the chosen models take, in the CLI's order; before a model is chosen, every model's.
  const pool = pick.models.filter((m) => pick.chosen.length === 0 || pick.chosen.includes(m.model))
  const efforts = [...new Set(pool.flatMap((m) => m.efforts))]
  const chosenEfforts = pick.efforts.filter((effort) => efforts.includes(effort))
  const count = pick.chosen.length * Math.max(1, chosenEfforts.length)
  return (
    <form className="orc-add__form orc-models" aria-label={title} onSubmit={(event) => { event.preventDefault(); if (count > 0) onAdd({ ...pick, efforts: chosenEfforts }) }}>
      <fieldset>
        <legend>{title}</legend>
        {pick.source === 'builtin' ? <p className="orc-hint">{t('settings.addModelsBuiltin')}</p> : null}
        {pick.models.map((m) => <label key={m.model} className="orc-models__item">
          <input type="checkbox" checked={pick.chosen.includes(m.model)} onChange={() => onPick({ ...pick, chosen: toggle(pick.chosen, m.model) })} />
          <span>{m.label}</span> <code>{m.model}</code>
        </label>)}
      </fieldset>
      {efforts.length ? <fieldset>
        <legend>{t('settings.addModelsEfforts')}</legend>
        <p className="orc-hint">{t('settings.addModelsEffortsHint')}</p>
        {efforts.map((effort) => <label key={effort} className="orc-models__item">
          <input type="checkbox" checked={chosenEfforts.includes(effort)} onChange={() => onPick({ ...pick, efforts: toggle(chosenEfforts, effort) })} />
          <span>{effort}</span>
        </label>)}
      </fieldset> : null}
      <div className="orc-add__buttons">
        <button type="submit" disabled={count === 0}>{t('settings.addModelsSubmit', { count })}</button>
        <button type="button" onClick={onCancel}>{t('settings.cancel')}</button>
      </div>
    </form>
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
  const [showOther, setShowOther] = useState(false)
  const [keep, setKeep] = useState<Record<string, string>>({})
  const [removeRest, setRemoveRest] = useState<string | null>(null)
  const [jump, setJump] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [kind, setKind] = useState<WorkerKind>('claude')
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('')
  const [labelEdited, setLabelEdited] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ id: string; field: 'label' | 'note'; value: string } | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [access, setAccess] = useState<Partial<Record<string, AccessResult | 'checking' | 'error'>>>({})
  const [formAccess, setFormAccess] = useState<AccessResult | 'checking' | 'error' | null>(null)
  const [pick, setPick] = useState<ModelPick | null>(null)
  const [providersOpen, setProvidersOpen] = useState<Record<string, boolean>>(readProvidersOpen)
  const dshSeen = useRef<string | null>(null)
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
      const presetResult = await shared.presets(root).catch(() => null)
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

  // dsh's models follow its configuration (pv1): the host re-reads the catalog when dsh's settings change and
  // on every refresh; a snapshot whose dsh rows differ, or a return to this tab, reloads the list here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshWorkers reads only refs and state setters; one subscription per mount.
  useEffect(() => {
    const reload = () => {
      // An unsaved order edit is the person's; the next change brings the list anyway.
      if (!repoRef.current || queued.current || inFlight.current) return
      void refreshWorkers().catch(() => {})
    }
    const off = hostEvents.subscribe('snapshot', (frame) => {
      if (!frame.ok) return
      const signature = dshSignature((frame.data as OrchestraSnapshot | null)?.workers)
      const previous = dshSeen.current
      dshSeen.current = signature
      if (previous !== null && previous !== signature) reload()
    })
    const onVisible = () => { if (document.visibilityState === 'visible') reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { off(); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // wo1: each CLI block says whether its CLI is installed and signed in — a local check that spends nothing.
  const checkedOnce = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: one automatic check per mount, once the list is loaded.
  useEffect(() => {
    if (load.kind !== 'ready' || checkedOnce.current) return
    checkedOnce.current = true
    const present = new Set(load.info.workers.flatMap((w) => (w.section === 'subscription' && w.cli ? [w.cli] : [])))
    for (const cli of [...BASE_CLIS, ...SUBSCRIPTION_CLIS_EXTRA.filter((item) => present.has(item))]) void checkAccess(cli)
  }, [load.kind])

  // A «Used in» chip or a preset's «not available» link brings its target into view once it is rendered.
  useEffect(() => {
    if (!jump) return
    const target = document.getElementById(jump)
    if (!target) return
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    target.focus({ preventScroll: true })
    setJump(null)
  })

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

  const checkAccess = async (target: string, targetModel = '', forForm = false) => {
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

  /** wo2: the person's choice for these blocks, remembered for this viewer. */
  const setOpen = (keys: string[], open: boolean) => {
    setProvidersOpen((prev) => {
      const next = { ...prev, ...Object.fromEntries(keys.map((key) => [key, open])) }
      writeProvidersOpen(next)
      return next
    })
  }

  const openPick = async (target: SubscriptionKind) => {
    if (pick?.kind === target) { setPick(null); return }
    setOpen([`cli:${target}`], true)
    setPick({ kind: target, state: 'loading' })
    try {
      const result = await postWorker<{ source: 'builtin' | 'cli'; models: SubscriptionModel[] }>('worker-models', { kind: target })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      setPick({ kind: target, state: 'ready', source: result.value.source, models: result.value.models, chosen: [], efforts: [] })
    } catch (error) {
      setPick({ kind: target, state: 'error', text: error instanceof Error ? error.message : t('settings.checkError') })
    }
  }

  const addPicked = async (current: Extract<ModelPick, { state: 'ready' }>) => {
    setSave({ kind: 'saving' })
    try {
      const models = current.models.filter((m) => current.chosen.includes(m.model)).map(({ model, label }) => ({ model, label }))
      const result = await postWorker<{ added: string[]; existing: string[] }>('worker-add-models', { kind: current.kind, models, efforts: current.efforts })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      await refreshWorkers()
      setPick(null)
      const { added, existing } = result.value
      const text = added.length ? [t('settings.addModelsAdded', { workers: added.join(', ') }), ...(existing.length ? [t('settings.addModelsExisting', { workers: existing.join(', ') })] : [])].join('; ') : t('settings.addModelsNone')
      setSave({ kind: 'saved', text })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.saveWorkerError') })
    }
  }

  const removeMany = async (ids: string[]) => {
    setSave({ kind: 'saving' })
    try {
      const removed: string[] = []
      for (const id of ids) {
        const result = await postWorker<{ removed: string[] }>('worker-delete', { id })
        if (!result.ok) throw new Error(describeApiError(result.error, result.message))
        removed.push(...result.value.removed)
      }
      setRemoveRest(null)
      await refreshWorkers()
      setSave({ kind: 'saved', text: t('settings.workerRemoved', { workers: [...new Set(removed)].join(', ') }) })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.removeWorkerError') })
    }
  }

  const adopt = async (id: string) => {
    setSave({ kind: 'saving' })
    try {
      const result = await postWorker('worker-adopt', { id })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      await refreshWorkers()
      setSave({ kind: 'saved', text: t('settings.adopted', { id }) })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.saveWorkerError') })
    }
  }

  const forget = async (id: string) => {
    setSave({ kind: 'saving' })
    try {
      const result = await postWorker('worker-forget', { id })
      if (!result.ok) throw new Error(describeApiError(result.error, result.message))
      const repo = repoRef.current
      const presetResult = repo ? await shared.presets(repo).catch(() => null) : null
      if (presetResult?.ok && Array.isArray(presetResult.value?.presets)) setPresets((old) => [...old.filter((p) => p.builtin), ...presetResult.value.presets])
      await refreshWorkers()
      setSave({ kind: 'saved', text: t('settings.forgotten', { id }) })
    } catch (error) {
      setSave({ kind: 'error', text: error instanceof Error ? error.message : t('settings.removeWorkerError') })
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
    // A dsh row is already named by the host: the owner's name when renamed, else dsh's catalog name (pv1).
    return entry && !worker.dsh ? { ...worker, label: workerLabel(entry.label, entryEffort(entry)), name: entry.label } : worker
  })
  const profiles = all.filter((w) => !registry.some((entry) => entry.id === w.id))
  const main = all.filter((w) => w.main)
  // wo1: every worker sits in exactly one section — the host decides it from the transport.
  const subscriptions = all.filter((w) => sectionOf(w) === 'subscription')
  const dshMain = all.filter((w) => sectionOf(w) === 'dsh')
  const others = all.filter((w) => sectionOf(w) === 'other')
  const catalog = load.info.catalog
  const dshEmpty = (catalog !== null && dshMain.length === 0) || Boolean(catalog?.groups.every((group) => group.models.length === 0))
  // wo1: with no dsh models at all, crewboard's built-in dsh route is not a blocked row under «No models yet» but one
  // line saying it waits for a key; the built-in preset skips it at launch until dsh lists the model (preflight).
  const dshWaiting = dshEmpty ? dshMain.filter((w) => w.dsh?.missing && w.dsh.builtin) : []
  const dshRows = dshMain.filter((w) => !dshWaiting.includes(w))
  const dshGroups = [...new Set(dshRows.map((w) => w.dsh?.providerName ?? ''))].map((name) => ({ name, list: dshRows.filter((w) => (w.dsh?.providerName ?? '') === name) }))
  const clis = [...BASE_CLIS, ...SUBSCRIPTION_CLIS_EXTRA.filter((cli) => subscriptions.some((w) => w.cli === cli))]
  const byId = new Map(all.map((w) => [w.id, w]))

  /** Every list that names the worker (pv1): the routing (the default preset) and each saved preset, by class and place. */
  const usesOf = (id: string): Use[] => {
    const hits: Use[] = []
    const scan = (lists: Routing['classes'], preset: string, text: (cls: TaskClass, position: number) => string) => {
      for (const cls of classes) {
        ;(lists[cls.id] ?? []).forEach((entry, i) => {
          if ((PROFILE_ALIASES[entry] ?? entry) === id) hits.push({ preset, cls: cls.id, label: text(cls.id, i + 1) })
        })
      }
    }
    scan(routing.classes, BUILTIN_PRESET, (cls, position) => t('settings.usedRouting', { class: CLASS_SHORT[cls], position }))
    for (const preset of presets) if (!preset.builtin) scan(preset.routing, preset.id, (cls, position) => t('settings.usedPreset', { preset: preset.label, class: CLASS_SHORT[cls], position }))
    return hits
  }
  const usedIn = (id: string): string => usesOf(id).map((use) => use.label).join(', ') || t('settings.notUsed')

  /** Display name and badge for a routing entry: a saved alias resolves to its folded direct row. */
  const nameOf = (id: string): { label: string; badge: string } => {
    const w = byId.get(PROFILE_ALIASES[id] ?? id)
    return { label: w?.label ?? id, badge: agentBadge(w?.id ?? id) }
  }
  const statusOf = (cli: string): CliStatus => cliStatus(access[cli])
  /**
   * Why this machine cannot run a worker now, if it cannot: switched off, gone from dsh, unknown, its CLI is not
   * signed in — or (wo2) Crewboard has no runner for its CLI.
   */
  const unavailable = (id: string): string | undefined => {
    const w = byId.get(PROFILE_ALIASES[id] ?? id)
    if (w && !runs(w)) return t('settings.notRunnable')
    if (!w || routing.disabled[id] !== undefined || routing.disabled[w.id] !== undefined || w.dsh?.missing || w.other === 'stale') return t('settings.notAvailable')
    const status = w.cli ? statusOf(w.cli) : 'unchecked'
    return status === 'missing' || status === 'signin' ? t('settings.notAvailable') : undefined
  }
  /** From a preset's entry back to the worker's row — or to its CLI's block when the CLI shows no models. */
  const showWorker = (id: string) => {
    const w = byId.get(PROFILE_ALIASES[id] ?? id)
    if (!w) return
    if (sectionOf(w) === 'other') setShowOther(true)
    if (w.dsh) setOpen([`dsh:${w.dsh.providerName}`], true)
    if (w.cli && sectionOf(w) === 'subscription') setOpen([`cli:${w.cli}`], true)
    const hidden = w.cli && !showsModels(statusOf(w.cli))
    setJump(hidden ? cliDomId(w.cli!) : workerDomId(w.id))
  }
  /** A «Used in» chip opens that preset and brings its class list into view. */
  const openUse = (use: Use) => {
    setPresetEdit(use.preset)
    setPresetName('')
    setJump(classDomId(use.preset, use.cls))
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
  const assignable = all.filter((w) => runs(w) && (w.main || (showOther && routing.disabled[w.id] === undefined && w.other !== 'stale')))

  const usesView = (uses: Use[]) => (
    <span className="orc-wrow__use">
      {uses.length ? uses.map((use) => (
        <button key={`${use.preset}:${use.cls}:${use.label}`} type="button" className="orc-use" aria-label={t('settings.openUse', { use: use.label })} onClick={() => openUse(use)}>{use.label}</button>
      )) : t('settings.notUsed')}
    </span>
  )

  /** The menu, rename, note and remove confirmation of one worker — the same wherever it is listed. */
  const workerTools = (w: WorkerInfo) => {
    const entry = registry.find((item) => item.id === w.id)
    const reason = routing.disabled[w.id]
    const uses = usedIn(w.id)
    return <>
      {entry?.note ? <p className="orc-wrow__note">{entry.note}</p> : null}
      {menuId === w.id ? <div className="orc-wrow__actions">
        {/* wo2: a worker Crewboard cannot run is listed for reference — the only thing to do with it is remove it. */}
        {runs(w) ? <button type="button" onClick={() => setEdit({ id: w.id, field: 'label', value: entry?.label ?? w.name ?? w.label })}>{t('settings.rename')}</button> : null}
        {runs(w) ? <button type="button" onClick={() => setEdit({ id: w.id, field: 'note', value: entry?.note ?? '' })}>{t('settings.note')}</button> : null}
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
        <span>{uses === t('settings.notUsed') ? t('settings.removePrompt', { label: w.label }) : t('settings.removeUsedPrompt', { label: w.label, uses })}</span>
        <button type="button" className="orc-danger" onClick={() => void removeEntry(w.id)}>{t('settings.removeWorker')}</button>
        <button type="button" onClick={() => setDeleteId(null)}>{t('settings.cancel')}</button>
      </div> : null}
      {reason !== undefined ? (
        <input
          className="orc-input orc-wrow__reason"
          aria-label={t('settings.disableReason', { id: w.id })}
          placeholder={t('settings.offReason')}
          value={reason}
          onChange={(e) => change({ ...routing, disabled: { ...routing.disabled, [w.id]: e.target.value } })}
        />
      ) : null}
    </>
  }

  /** One worker of a model row: its effort chip, where it is used, and its own «Enabled» switch. */
  const workerLine = (w: WorkerInfo) => {
    const off = routing.disabled[w.id] !== undefined
    const blocked = Boolean(w.dsh?.missing)
    return (
      <div key={w.id} id={workerDomId(w.id)} tabIndex={-1} className={`orc-wline${off || blocked ? ' orc-wline--off' : ''}`}>
        <div className="orc-wline__main">
          {w.effort ? <span className="orc-effort">{w.effort}</span> : null}
          {blocked ? <span className="orc-wrow__missing" title={t('settings.dshMissingHint')}>{t('settings.dshBlocked')}</span> : null}
          {usesView(usesOf(w.id))}
          {runs(w) ? <button
            type="button"
            role="switch"
            aria-checked={!off && !blocked}
            aria-label={t('settings.workerAria', { id: w.id })}
            className="orc-switch"
            disabled={blocked}
            onClick={() => toggle(w.id, !off)}
          /> : <span aria-hidden="true" />}
          <button type="button" className="orc-wrow__menu-button" aria-label={t('settings.actions', { label: w.label })} aria-expanded={menuId === w.id}
            onClick={() => { setMenuId(menuId === w.id ? null : w.id); setEdit(null); setDeleteId(null) }}>···</button>
        </div>
        {workerTools(w)}
      </div>
    )
  }

  /** One model: its name once, then one line per effort — each effort is its own worker. */
  const modelRow = (row: WorkerInfo[]) => {
    const first = row[0]!
    const name = first.name ?? first.label
    const detail = row.length === 1 ? (first.id !== name ? first.id : undefined) : first.model
    return (
      <li key={first.id} className="orc-mrow">
        <div className="orc-mrow__head">
          <span className="orc-wk" aria-hidden="true">{agentBadge(first.id)}</span>
          <span className="orc-wrow__name">
            <span className="orc-wrow__label">{name}</span>
            {detail ? <span className="orc-wrow__id">{detail}</span> : null}
          </span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: A group of per-effort lines, not a form fieldset. */}
        <div className="orc-mrow__lines" role="group" aria-label={t('settings.effortsOf', { label: name })}>{row.map(workerLine)}</div>
      </li>
    )
  }
  const caption = <div className="orc-wcap" aria-hidden="true"><span /><span>{t('settings.usedIn')}</span><span className="orc-wcap__sw">{t('settings.enabled')}</span></div>

  type ProviderBlock = {
    key: string
    domId?: string
    name: string
    /** What the region and its disclosure are called (a dsh group adds «· via dsh»). */
    label: string
    via?: string
    status: string
    login?: string
    list: WorkerInfo[]
    /** The one action the folded line keeps, and the ones the open block adds before it. */
    action?: ReactNode
    extra?: ReactNode
    /** Its models are listed for reference only (wo2): folded by default, and it says so. */
    note?: string
    /** Whether the block lists its models at all (a CLI that is missing or signed out does not). */
    showsRows: boolean
    body?: ReactNode
  }
  /** wo2: a block opens by default when one of its models is used; the person's own choice wins. */
  const isOpen = (block: Pick<ProviderBlock, 'key' | 'list' | 'note'>): boolean =>
    providersOpen[block.key] ?? (!block.note && block.list.some((w) => usesOf(w.id).length > 0))
  /**
   * One provider (wo2): folded, a single line — its name, status, «N models · M in presets» and its main action;
   * a click anywhere on that line but a button opens it.
   */
  const providerBlock = (block: ProviderBlock) => {
    const rows = modelRows(block.list)
    const used = rows.filter((row) => row.some((w) => usesOf(w.id).length > 0)).length
    const open = isOpen(block)
    const bodyId = `orc-provider-${block.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    const toggleOpen = () => setOpen([block.key], !open)
    return (
      <section key={block.key} id={block.domId} tabIndex={-1} className={`orc-cli${open ? '' : ' orc-cli--folded'}`} aria-label={block.label}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: A pointer shortcut; the disclosure button is the keyboard route. */}
        <div className="orc-cli__head" onClick={(event) => { if (!(event.target as HTMLElement).closest('button, code, a, input')) toggleOpen() }}>
          <h4 className="orc-cli__name">
            <button type="button" className="orc-disclose" aria-expanded={open} aria-controls={bodyId} onClick={toggleOpen}>
              <span className="orc-disclose__mark" aria-hidden="true">▸</span>
              {block.name}{block.via ? <span className="orc-wgroup__via"> · {block.via}</span> : null}
            </button>
          </h4>
          <span className="orc-cli__state">{block.status}</span>
          {rows.length ? <span className="orc-cli__count">{t('settings.providerCount', { count: rows.length, used })}</span> : null}
          {open && block.login ? <code title={block.login}>{block.login}</code> : null}
          {block.action || (open && block.extra) ? <span className="orc-cli__actions">{open ? block.extra : null}{block.action}</span> : null}
        </div>
        {block.note ? <p className="orc-hint">{block.note}</p> : null}
        {open ? <div id={bodyId}>
          {block.body}
          {block.showsRows && rows.length ? <ul className="orc-set__list">{rows.map(modelRow)}</ul> : null}
        </div> : null}
      </section>
    )
  }

  /** Whether the host has a runner for this CLI; an older host without the list says it per worker. */
  const cliRunsHere = (cli: SubscriptionCli): boolean =>
    load.info.runnableClis ? load.info.runnableClis.includes(cli) : !subscriptions.some((w) => w.cli === cli && w.runs === false)
  const cliBlockOf = (cli: SubscriptionCli): ProviderBlock => {
    const info = CLI_INFO[cli]
    const status = statusOf(cli)
    const check = <button type="button" disabled={status === 'checking'} onClick={() => void checkAccess(cli)}>{t('settings.checkAccess')}</button>
    const add = status === 'signed' && isPickable(cli) ? <button type="button" aria-expanded={pick?.kind === cli} onClick={() => void openPick(cli)}>{t('settings.addModels')}</button> : null
    return {
      key: `cli:${cli}`,
      domId: cliDomId(cli),
      name: info.name,
      label: info.name,
      status: t(`settings.cliStatus.${status}`),
      ...(info.login ? { login: info.login } : {}),
      list: subscriptions.filter((w) => w.cli === cli),
      // Signed in, the main action is «Add models»; until then it is «Check access».
      action: add ?? check,
      ...(add ? { extra: check } : {}),
      ...(cliRunsHere(cli) ? {} : { note: t('settings.cliReference', { name: info.name }) }),
      showsRows: showsModels(status),
      body: pick?.kind === cli ? <ModelPicker pick={pick} onPick={setPick} onAdd={(current) => void addPicked(current)} onCancel={() => setPick(null)} /> : null,
    }
  }
  const cliBlocks = clis.map(cliBlockOf)
  const dshBlocks: ProviderBlock[] = dshGroups.map((g) => ({
    key: `dsh:${g.name}`,
    name: g.name,
    label: `${g.name} · ${t('settings.viaDsh')}`,
    via: t('settings.viaDsh'),
    status: t('settings.providerDshStatus'),
    list: g.list,
    showsRows: true,
  }))
  /** «Expand all / Fold all» at a section's head: folds when every block is open, else opens them all. */
  const foldAll = (blocks: ProviderBlock[]) => {
    if (blocks.length < 2) return null
    const allOpen = blocks.every(isOpen)
    return <button type="button" className="orc-linkbtn orc-wsec__fold" onClick={() => setOpen(blocks.map((block) => block.key), !allOpen)}>{allOpen ? t('settings.foldAll') : t('settings.expandAll')}</button>
  }

  // «Other / imported» (wo1): one entry per duplicate group, imported profile and stale id.
  const duplicateGroups = [...new Set(others.flatMap((w) => (w.other === 'duplicate' && w.duplicateOf ? [w.duplicateOf] : [])))].map((kept) => ({ kept, copies: others.filter((w) => w.duplicateOf === kept) }))
  const imported = others.filter((w) => w.other === 'imported' || (w.other !== 'duplicate' && w.other !== 'stale'))
  const stale = others.filter((w) => w.other === 'stale')
  const otherCount = duplicateGroups.length + imported.length + stale.length
  const duplicateEntry = (group: { kept: string; copies: WorkerInfo[] }) => {
    const ids = [group.kept, ...group.copies.map((w) => w.id)]
    const picked = keep[group.kept]
    const chosen = picked && ids.includes(picked) ? picked : group.kept
    const rest = ids.filter((id) => id !== chosen)
    const label = byId.get(group.kept)?.label ?? group.kept
    return (
      <li key={`dup:${group.kept}`} className="orc-oentry">
        <fieldset className="orc-oentry__keep">
          <legend>{t('settings.duplicateTitle', { label, count: ids.length })}</legend>
          <span className="orc-hint">{t('settings.keepOne')}</span>
          {ids.map((id) => {
            const w = byId.get(id)
            return <label key={id} id={id === group.kept ? undefined : workerDomId(id)} className="orc-models__item">
              <input type="radio" name={`keep:${group.kept}`} checked={chosen === id} onChange={() => { setKeep((prev) => ({ ...prev, [group.kept]: id })); setRemoveRest(null) }} />
              <span>{w?.label ?? id}</span> <code>{id}</code>
              {w ? usesView(usesOf(id)) : null}
            </label>
          })}
        </fieldset>
        <div className="orc-oentry__actions">
          <button type="button" onClick={() => setRemoveRest(group.kept)}>{t('settings.removeRest')}</button>
        </div>
        {removeRest === group.kept ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-wrow__confirm" role="group" aria-label={t('settings.deleteAria', { label })}>
          <span>{t('settings.removeRestPrompt', { workers: rest.join(', ') })}</span>
          <button type="button" className="orc-danger" onClick={() => void removeMany(rest)}>{t('settings.removeRest')}</button>
          <button type="button" onClick={() => setRemoveRest(null)}>{t('settings.cancel')}</button>
        </div> : null}
      </li>
    )
  }
  const importedEntry = (w: WorkerInfo) => (
    <li key={w.id} id={workerDomId(w.id)} tabIndex={-1} className="orc-oentry">
      <div className="orc-oentry__line">
        <span className="orc-wk" aria-hidden="true">{agentBadge(w.id)}</span>
        <span className="orc-wrow__name">
          <span className="orc-wrow__label">{w.label}</span>
          <span className="orc-wrow__id">{w.id} · {t('settings.importedFrom', { cli: w.transport ? TRANSPORT_NAME[w.transport] ?? w.transport : '—' })}</span>
        </span>
        {usesView(usesOf(w.id))}
      </div>
      <div className="orc-oentry__actions">
        <button type="button" onClick={() => void adopt(w.id)}>{t('settings.addAsWorker')}</button>
        <button type="button" onClick={() => { setDeleteId(w.id); setMenuId(null) }}>{t('settings.remove')}</button>
      </div>
      {deleteId === w.id ? /* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */ <div className="orc-wrow__confirm" role="group" aria-label={t('settings.deleteAria', { label: w.label })}>
        <span>{usedIn(w.id) === t('settings.notUsed') ? t('settings.removePrompt', { label: w.label }) : t('settings.removeUsedPrompt', { label: w.label, uses: usedIn(w.id) })}</span>
        <button type="button" className="orc-danger" onClick={() => void removeEntry(w.id)}>{t('settings.removeWorker')}</button>
        <button type="button" onClick={() => setDeleteId(null)}>{t('settings.cancel')}</button>
      </div> : null}
    </li>
  )
  const staleEntry = (w: WorkerInfo) => (
    <li key={w.id} id={workerDomId(w.id)} tabIndex={-1} className="orc-oentry">
      <div className="orc-oentry__line">
        <span className="orc-wk" aria-hidden="true">{agentBadge(w.id)}</span>
        <span className="orc-wrow__name">
          <span className="orc-wrow__label">{w.id}</span>
          <span className="orc-wrow__id">{t('settings.staleId')}</span>
        </span>
        {usesView(usesOf(w.id))}
      </div>
      <div className="orc-oentry__actions">
        <button type="button" onClick={() => void forget(w.id)}>{t('settings.remove')}</button>
      </div>
    </li>
  )

  return (
    <div className="orc-settings">
      <section className="orc-block" aria-label={t('settings.workers')}>
        <h2 className="orc-block__head">
          <span>{t('settings.workers')}</span>
          <span className="orc-col__count">{main.length}</span>
        </h2>
        <p className="orc-hint">{t('settings.workersHint')}</p>

        <section className="orc-wsec" aria-label={t('settings.subscriptions')}>
          <h3 className="orc-wsec__title"><span>{t('settings.subscriptions')}</span>{foldAll(cliBlocks)}</h3>
          {cliBlocks.some((block) => block.showsRows && block.list.length > 0 && isOpen(block)) ? caption : null}
          {cliBlocks.map(providerBlock)}
          <div className="orc-add">
            <button type="button" className="orc-add__trigger" aria-expanded={adding} onClick={() => { setAdding(!adding); setFormAccess(null) }}>{t('settings.addWorker')}</button>
            {adding ? <form className="orc-add__form" onSubmit={(event) => {
              event.preventDefault()
              const value = model.trim()
              if (!label.trim() || (kind !== 'devin' && !value)) return
              const id = kind === 'devin' ? 'devin' : `${kind}/${value}`
              void saveEntry({ id, kind, ...(kind === 'dsh' || kind === 'devin' ? {} : { model: value }), label: label.trim(), billing: kind === 'dsh' ? 'API' : kind === 'devin' ? '\u043f\u0440\u043e\u043c\u043e' : '\u043f\u043e\u0434\u043f\u0438\u0441\u043a\u0430' })
            }}>
              <label>{t('settings.workerType')}<select className="orc-select" value={kind} onChange={(event) => { const next = event.target.value as WorkerKind; setKind(next); setModel(''); setLabel(defaultName(next, '', catalog, profiles)); setLabelEdited(false); setFormAccess(null) }}>
                {/* dsh models list themselves from dsh's catalog (pv1); the form adds subscription CLIs. */}
                {(['claude', 'codex', 'devin', 'opencode', 'cursor', 'gemini', 'grok'] as const).map((item) => <option key={item} value={item}>{KIND_NAMES[item]}</option>)}
              </select></label>
              {kind === 'devin' || kind === 'dsh' ? null : <label>{t('settings.modelId')}<input className="orc-input" value={model} placeholder={t(`settings.modelExample.${kind}`)} onChange={(event) => { setModel(event.target.value); if (!labelEdited) setLabel(defaultName(kind, event.target.value, catalog, profiles)); setFormAccess(null) }} /></label>}
              {kind === 'devin' ? <p className="orc-hint">{t('settings.devinModelHint')}</p> : null}
              {kind === 'dsh' ? null : <div className="orc-add__check"><button type="button" disabled={formAccess === 'checking'} onClick={() => void checkAccess(kind, model, true)}>{t('settings.check')}</button><span role="status">{formAccess === 'checking' ? t('settings.checkForm') : formAccess === 'error' ? t('settings.checkFormError') : formAccess ? (formAccess.ok ? t('settings.cliAvailable') : formAccess.checks.filter((check) => !check.ok).map((check) => `${check.detail}${check.fix ? ` · ${check.fix}` : ''}`).join('; ')) : t('settings.checkManual')}</span></div>}
              <label>{t('settings.workerName')}<input className="orc-input" value={label} onChange={(event) => { setLabel(event.target.value); setLabelEdited(true) }} /></label>
              <div className="orc-add__buttons"><button type="submit" disabled={!label.trim() || (kind !== 'devin' && !model.trim())}>{t('settings.add')}</button><button type="button" onClick={() => setAdding(false)}>{t('settings.cancel')}</button></div>
            </form> : null}
          </div>
        </section>

        <section className="orc-wsec" aria-label={t('settings.viaDshTitle')}>
          <h3 className="orc-wsec__title"><span>{t('settings.viaDshTitle')}</span>{foldAll(dshBlocks)}</h3>
          <p className="orc-hint">{t('settings.dshKeysHint')} <button type="button" className="orc-linkbtn" onClick={() => { if (!openDshModels()) setSave({ kind: 'saved', text: t('settings.openDshFallback') }) }}>{t('settings.openDshSettings')}</button></p>
          {catalog === null ? <p className="orc-hint">{t('settings.dshCatalogUnavailable')}</p> : null}
          {dshEmpty ? <p className="orc-set__empty">{t('settings.dshEmpty')}</p> : null}
          {dshWaiting.map((w) => <p key={w.id} id={workerDomId(w.id)} tabIndex={-1} className="orc-hint">{t('settings.dshBuiltinWaiting', { name: w.dsh?.builtin ?? w.label })}</p>)}
          {dshBlocks.some(isOpen) ? caption : null}
          {dshBlocks.map(providerBlock)}
          {catalog?.failures.map((failure) => <p key={failure.id} className="orc-hint">{t('settings.dshFailure', { name: failure.name, message: failure.message })}</p>)}
        </section>

        {otherCount > 0 ? (
          <section className="orc-wsec" aria-label={t('settings.otherTitle', { count: otherCount })}>
            <h3 className="orc-wsec__title">
              <button type="button" className="orc-disclose" aria-expanded={showOther} onClick={() => setShowOther((v) => !v)}>
                <span className="orc-disclose__mark" aria-hidden="true">▸</span>
                {t('settings.otherTitle', { count: otherCount })}
              </button>
            </h3>
            <p className="orc-hint">{t('settings.otherHint')}</p>
            {showOther ? (
              <ul className="orc-set__list orc-extra__body">
                {duplicateGroups.map(duplicateEntry)}
                {imported.map(importedEntry)}
                {stale.map(staleEntry)}
              </ul>
            ) : null}
          </section>
        ) : null}
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
                const pool = preset.builtin ? assignable.filter((w) => !list.some((id) => (PROFILE_ALIASES[id] ?? id) === w.id)) : all.filter((w) => runs(w) && !list.includes(w.id))
                return <WorkerOrder key={`${preset.id}-${cls.id}`} domId={classDomId(preset.builtin ? BUILTIN_PRESET : preset.id, cls.id)} cls={cls} list={list} disabled={routing.disabled} pool={pool} nameOf={nameOf} unavailable={unavailable} onShow={showWorker} onList={(next) => preset.builtin ? setList(cls.id, next) : void savePreset({ ...preset, routing: { ...preset.routing, [cls.id]: next } })} />
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

      <section className="orc-set__section"><button type="button" className="orc-btn orc-btn--ghost" onClick={() => { try { globalThis.localStorage?.removeItem(TOUR_KEY) } catch { /* optional storage */ } if (repoRef.current) void api.exampleCreate(repoRef.current, getLang()).then((result) => { if (result.ok) { selectMainPanel(PANEL_ID); window.dispatchEvent(new Event('orchestra:show-introduction')) } }) }}>{t('welcome.showAgain')}</button></section>
      <WorktreeSettings repo={repoRef.current!} />

      <p className={`orc-set__status${save.kind === 'error' ? ' orc-set__status--err' : ''}`} role="status">
        {save.kind === 'saving' ? t('settings.saving') : save.kind === 'saved' ? save.text ?? t('settings.saved') : save.kind === 'error' ? save.text : ''}
      </p>
    </div>
  )
}
