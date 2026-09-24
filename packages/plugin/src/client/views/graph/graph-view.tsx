import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Attention, TaskSnapshot } from '../../../shared/types.js'
import { useAction } from '../../actions.js'
import { api } from '../../api.js'
import { t, useLang } from '../../i18n.js'
import { decideFolds, foldGraph, readManualFolds, taskCount, writeManualFold } from '../../fold.js'
import { lensIds, lensTasks } from '../../lens.js'
import { identityLabel, runFact, workerIdentity } from '../../provider.js'
import { taskTone } from '../../styles.js'
import { isChecking } from '../../../../../core/src/plan/graph.js'
import { isHandPicked } from '../../workers.js'
import { acceptableTasks } from '../accept-batch.js'
import type { ViewProps } from '../types.js'
import { type Camera, type Pose, LENS_RESPONSE, createCamera } from './camera.js'
import { alertIds, chainOf } from './chain.js'
import { elkReady, loadElk } from './elk.js'
import { NODE_H, NODE_W, type LaneBand, type NodePos, contentBox, laneBands, laneOf, laneTitle, layoutFoldStack, layoutGraph } from './layout.js'
import { MAP_H, MAP_W, type MapNode, Minimap, mapProjection } from './minimap.js'
import { appear, edgePath, flash, leave, lightEdge } from './motion.js'
import { GraphSearch } from './search.js'
import { type Spring, settled, snap, spring, springStep } from './spring.js'
import { VendorMark as VendorMarkImpl } from '../../vendor-mark.js'

/** Events arriving inside one window are applied as a single move — the graph must never twitch six times. */
const BURST_MS = 150
const LEAVE_MS = 170
const AWAY_MS = 5000
const OFFSCREEN_MS = 1800
const DRAG_SLOP = 4
const FAN_W = 210
const FAN_ROW_H = 34
const VendorMark = memo(VendorMarkImpl, (a, b) => JSON.stringify(a.identity) === JSON.stringify(b.identity))

type Ghost = { id: string; title: string; pos: NodePos }

/** Place the preview on a free side, including labels in the collision check. */
export function fanPosition(chip: NodePos, count: number, nodes: Map<string, NodePos>, bands: LaneBand[]): { x: number; y: number; side: 'left' | 'right' } {
  const height = count * FAN_ROW_H + 12
  const minX = Math.min(...[...nodes.values()].map((p) => p.x))
  const clear = (x: number, y: number) => {
    const hit = (left: number, top: number, width: number, h: number) => x < left + width && x + FAN_W > left && y < top + h && y + height > top
    if ([...nodes.values()].some((p) => hit(p.x, p.y, NODE_W, NODE_H))) return false
    return !bands.some((band) => !band.folded && hit(minX - 12, band.top + 4, 205, 20))
  }
  const right = chip.x + NODE_W + 12
  const left = chip.x - FAN_W - 12
  if (clear(right, chip.y)) return { x: right, y: chip.y, side: 'right' }
  if (left >= 0 && clear(left, chip.y)) return { x: left, y: chip.y, side: 'left' }
  return { x: minX - FAN_W - 12, y: chip.y, side: 'left' }
}

/* ------------------------------------------------------------------ hooks */

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
  } catch {
    return false
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    const mq = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq?.addEventListener) return
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** Leading-edge throttle: the first change lands at once, the rest of the burst lands together. */
function useBurst<T>(value: T): T {
  const [held, setHeld] = useState(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  latest.current = value
  useEffect(() => {
    if (value === held || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setHeld(latest.current)
    }, BURST_MS)
  }, [value, held])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  return held
}

/* ------------------------------------------------------------------ view */

/**
 * Where the camera should land when a plan opens: the work that is alive right now, newest first.
 * Nothing alive — the caller frames the whole plan instead.
 */
export function liveTask(tasks: readonly TaskSnapshot[]): string | undefined {
  const rank = (t: TaskSnapshot): number => (t.status === 'running' ? 0 : t.status === 'in_review' ? 1 : t.status === 'ready' ? 2 : 3)
  const live = tasks.filter((t) => rank(t) < 3).sort((a, b) => rank(a) - rank(b) || (b.lastRunId ?? '').localeCompare(a.lastRunId ?? ''))
  return live[0]?.id
}

function GraphViewImpl({ repo, workers, selectedId, onSelect, density, toggleDensity, lens = null, setLens, walk, lensStep, camera: given }: ViewProps & { camera?: Camera }) {
  const lang = useLang()
  const shown = useBurst(repo)
  const reduced = useReducedMotion()
  const reducedRef = useRef(reduced)
  reducedRef.current = reduced

  const tasks = shown.tasks
  type ManualPos = { x: number; y: number } | null
  type Move = { id: string; before: ManualPos; after: ManualPos }
  const [overrides, setOverrides] = useState<Map<string, ManualPos>>(() => new Map())
  const overrideRef = useRef(overrides)
  overrideRef.current = overrides
  type HistoryEntry = { moves: Move[]; scope?: string | true }
  const history = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] })
  const expected = useRef(new Map<string, ManualPos[]>())
  const writeQueue = useRef(Promise.resolve())
  const layoutVersion = useRef(0)
  const observed = useRef<{ plan: string; positions: Map<string, ManualPos> } | null>(null)
  const currentPlan = `${shown.root}\n${shown.planId ?? ''}`
  const actualPositions = new Map(tasks.map((task) => [task.id, task.pos ?? null] as const))
  if (observed.current?.plan !== currentPlan) {
    observed.current = { plan: currentPlan, positions: actualPositions }
    history.current = { undo: [], redo: [] }
    expected.current.clear()
    if (overrideRef.current.size) { overrideRef.current = new Map(); queueMicrotask(() => setOverrides(new Map())) }
  } else {
    for (const [id, pos] of actualPositions) {
      const old = observed.current.positions.get(id)
      if (old && (old.x !== pos?.x || old.y !== pos?.y) || old === null && pos !== null || old !== null && pos === null) {
        const pending = expected.current.get(id) ?? []
        const matched = pending.findIndex((wanted) => wanted?.x === pos?.x && wanted?.y === pos?.y)
        if (matched >= 0) {
          const rest = pending.slice(matched + 1)
          if (rest.length) expected.current.set(id, rest)
          else expected.current.delete(id)
        }
        else { history.current = { undo: [], redo: [] }; expected.current.clear(); overrideRef.current = new Map(); queueMicrotask(() => setOverrides(new Map())) }
      }
    }
    observed.current.positions = actualPositions
  }
  const activeOverrides = overrideRef.current
  const [manual, setManual] = useState<Record<string, boolean>>(() => readManualFolds(repo))
  const foldKey = `${shown.root}:${shown.planId ?? ''}`
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => setManual(readManualFolds(shown)), [foldKey, shown.tasks])
  const decision = useMemo(() => decideFolds(shown, manual, new Date()), [shown, manual])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Locale changes intentionally refresh the translated result.
  const graph = useMemo(() => foldGraph(shown, decision), [shown, decision, lang])
  // biome-ignore lint/correctness/useExhaustiveDependencies: Override and plan revisions intentionally control graph rebuilding.
  const graphTasks = useMemo<TaskSnapshot[]>(() => {
    const depsByTarget = new Map<string, string[]>()
    for (const edge of graph.edges) {
      const deps = depsByTarget.get(edge.to)
      if (deps) deps.push(edge.from)
      else depsByTarget.set(edge.to, [edge.from])
    }
    return graph.nodes.map((node) => node.task
      ? { ...node.task, deps: depsByTarget.get(node.id) ?? [], pos: node.guest ? undefined : activeOverrides.has(node.id) ? activeOverrides.get(node.id) ?? undefined : node.task.pos }
      : { id: node.id, title: node.lane, kind: 'implement' as const, status: 'accepted' as const, lane: node.lane,
        deps: depsByTarget.get(node.id) ?? [], blockedBy: [], needsHuman: false, runs: 0 })
  }, [graph, overrides, currentPlan])
  const toggleFold = (lane: string) => {
    const folded = !decision.folded.has(lane)
    writeManualFold(shown, lane, folded)
    setManual((old) => ({ ...old, [lane]: folded }))
    setFanLane(null)
  }
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const alerts = useMemo(() => alertIds(shown.attention), [shown.attention])
  const attentionOf = useMemo(() => {
    const map = new Map<string, Attention>()
    for (const a of shown.attention) if (!map.has(a.taskId) || a.severity === 'alert') map.set(a.taskId, a)
    return map
  }, [shown.attention])
  const edges = graph.edges

  const [nodes, setNodes] = useState<Map<string, NodePos>>(() => new Map())
  const [foldBands, setFoldBands] = useState<LaneBand[]>([])
  const [ghosts, setGhosts] = useState<Ghost[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  // Acceptance from the node badge goes through the same route and the same macOS window as the panel.
  const accept = useAction()
  const [fanLane, setFanLane] = useState<string | null>(null)
  const [fanPointer, setFanPointer] = useState(false)
  const [fanClosing, setFanClosing] = useState(false)
  const fanTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fanRemoveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFanLane(null) }
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('keydown', close); if (fanTimer.current) clearTimeout(fanTimer.current); if (fanRemoveTimer.current) clearTimeout(fanRemoveTimer.current) }
  }, [])
  const [critical, setCritical] = useState(false)
  const [away, setAway] = useState<Set<string>>(() => new Set())
  const [offscreen, setOffscreen] = useState<{ x: number; y: number; tone: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const worldRef = useRef<HTMLDivElement | null>(null)
  const mapFrameRef = useRef<HTMLSpanElement | null>(null)
  const els = useRef(new Map<string, HTMLDivElement>())
  const paths = useRef(new Map<string, SVGPathElement>())
  const springs = useRef(new Map<string, { x: Spring; y: Spring }>())
  const targets = useRef(nodes)
  const placed = useRef(new Map<string, NodePos>())
  const layoutOverride = useRef<Map<string, NodePos> | null>(null)
  const cameraRef = useRef<Camera | null>(null)
  cameraRef.current ??= given ?? createCamera()
  const camera = cameraRef.current

  targets.current = nodes

  /* ---------------------------------------------------------- layout */

  // Only the shape of the plan (ids, deps, lanes, pins) triggers a relayout; a status change never does.
  const shapeKey = useMemo(
    () => graphTasks.map((t) => `${t.id}|${t.kind}|${t.lane ?? ''}|${t.deps.join(',')}|${t.pos ? `${t.pos.x},${t.pos.y}` : ''}`).join(';'),
    [graphTasks],
  )
  // Positions are remembered per plan: a sibling plan may reuse task ids, and its kept positions
  // would land those nodes inside this plan's lane frames.
  const arrived = useRef(false)
  const planRef = useRef(`${shown.root}\n${shown.planId ?? ''}`)
  const revisionRef = useRef(shown.rev)
  if (shown.rev > revisionRef.current) revisionRef.current = shown.rev
  const tasksRef = useRef(tasks)
  tasksRef.current = graphTasks
  const [fitNonce, setFitNonce] = useState(0)

  // The precise layout engine is three megabytes: it is fetched only now that the graph is on
  // screen, and until it lands the plan is laid out by dependency levels.
  const [precise, setPrecise] = useState(elkReady)
  const preciseApplied = useRef(elkReady())
  useEffect(() => {
    if (precise) return
    let alive = true
    void loadElk().then((ok) => {
      if (ok && alive) setPrecise(true)
    })
    return () => {
      alive = false
    }
  }, [precise])

  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    let alive = true
    const planKey = `${shown.root}\n${shown.planId ?? ''}`
    if (planRef.current !== planKey) {
      planRef.current = planKey
      revisionRef.current = shown.rev
      placed.current = new Map()
      springs.current.clear()
      // A different plan is a different canvas: keeping the old scroll leaves the reader staring at
      // empty space, because plans differ in size. Go to the live work, or frame the whole plan.
      arrived.current = false
    }
    // The one relayout that is allowed to move settled nodes: the springs carry the plan from the
    // level positions to the ELK ones, and a camera the reader has not touched re-fits after it.
    const reflow = precise && !preciseApplied.current
    preciseApplied.current ||= precise
    const stacked = decision.folded.size ? layoutFoldStack(tasksRef.current, decision.folded) : null
    if (stacked) setFoldBands(stacked.bands)
    else setFoldBands([])
    const override = layoutOverride.current
    layoutOverride.current = null
    const placement = override ? Promise.resolve(override) : stacked ? Promise.resolve(stacked.nodes) : layoutGraph(tasksRef.current, reflow || placed.current.size !== graphTasks.length || [...placed.current.keys()].some((id) => !graphTasks.some((t) => t.id === id)) ? undefined : placed.current)
    placement
      .then((next) => {
        if (!alive) return
        placed.current = next
        setNodes(next)
        if (!arrived.current && next.size > 0) {
          arrived.current = true
          const live = liveTask(tasksRef.current)
          const spot = live ? next.get(live) : undefined
          requestAnimationFrame(() => (spot ? camera.centerOn(spot.x + NODE_W / 2, spot.y + NODE_H / 2, reducedRef.current) : camera.fit(reducedRef.current)))
          return
        }
        if (reflow && !camera.touched) requestAnimationFrame(() => camera.fit(reducedRef.current))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [shapeKey, shown.root, shown.planId, fitNonce, precise, camera, decision.folded])

  const bands = useMemo(() => decision.folded.size ? foldBands : laneBands(nodes), [nodes, foldBands, decision.folded])
  const box = useMemo(() => {
    const bounds = contentBox(nodes)
    return decision.folded.size ? { ...bounds, minX: 0 } : bounds
  }, [nodes, decision.folded])
  const laneLeft = nodes.size ? Math.min(...[...nodes.values()].map((p) => p.x)) - 22 : -22
  camera.setContent(box)

  // The minimap frame follows the camera at 60 fps, so it is written straight to the element —
  // re-rendering the map on every frame would cost more than the whole graph.
  const projection = useMemo(() => mapProjection(box), [box])
  const projectionRef = useRef(projection)
  projectionRef.current = projection

  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || nodes.size === 0) return
    fitted.current = true
    camera.fit(reducedRef.current)
  }, [nodes, camera])

  // The amber ring marks «waiting for the human» whatever the lens — the same set that fills
  // the queue, decisions included.
  const reviewIds = useMemo(() => new Set(acceptableTasks(shown).map((t) => t.id)), [shown])

  // A lens: the plan is never filtered. Matching nodes stay bright, everything else steps back to
  // a quarter, and the camera goes to the matches — centred on one, fitted around several.
  const matchIds = useMemo(() => lensIds(shown, lens), [shown, lens])
  const visibleMatchIds = useMemo(() => {
    const ids = new Set(matchIds)
    for (const id of matchIds) {
      const task = byId.get(id)
      if (task && decision.folded.has(laneOf(task))) ids.add(`lane:${laneOf(task)}`)
    }
    return ids
  }, [matchIds, byId, decision])
  const matchOrder = useMemo(() => lensTasks(shown, lens).map((t) => t.id), [shown, lens])
  const matchKey = matchOrder.join(',')
  const lensOn = lens !== null && matchIds.size > 0

  // The pose saved when a lens switches on is the pose «off» flies back to — including whether
  // the reader had claimed the camera, so an untouched camera stays untouched afterwards.
  const savedPose = useRef<Pose | null>(null)
  const framed = useRef<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: The selected identity and request keys intentionally control this hook’s refresh cadence.
  useEffect(() => {
    if (!lensOn || !lens) {
      const pose = savedPose.current
      savedPose.current = null
      framed.current = null
      if (pose) camera.restore(pose, reducedRef.current)
      return
    }
    if (!savedPose.current) savedPose.current = camera.pose()
    const spots = matchOrder.map((id) => targets.current.get(id) ?? (byId.get(id) && targets.current.get(`lane:${laneOf(byId.get(id)!)}`))).filter((p): p is NodePos => !!p)
    if (spots.length === 0) return
    // Reframe when the lens or its membership changes; a relayout alone never re-yanks the camera.
    if (framed.current === `${lens}:${matchKey}`) return
    framed.current = `${lens}:${matchKey}`
    if (spots.length === 1) {
      camera.centerOn(spots[0].x + NODE_W / 2, spots[0].y + NODE_H / 2, reducedRef.current, LENS_RESPONSE)
      return
    }
    camera.fitBox(
      {
        minX: Math.min(...spots.map((p) => p.x)),
        minY: Math.min(...spots.map((p) => p.y)),
        maxX: Math.max(...spots.map((p) => p.x)) + NODE_W,
        maxY: Math.max(...spots.map((p) => p.y)) + NODE_H,
      },
      reducedRef.current,
      64,
      LENS_RESPONSE,
    )
  }, [lens, lensOn, matchKey, matchOrder, camera, nodes])

  // Walking the matches: `n` selected the next one — the camera centres it at the current zoom.
  useEffect(() => {
    if (!walk) return
    const pos = targets.current.get(walk.id) ?? (byId.get(walk.id) && targets.current.get(`lane:${laneOf(byId.get(walk.id)!)}`))
    if (pos) camera.centerOn(pos.x + NODE_W / 2, pos.y + NODE_H / 2, reducedRef.current, LENS_RESPONSE)
    // seq ticks on every step, so walking back to the same match still moves the camera.
  }, [walk, camera, byId])

  /* ---------------------------------------------------------- frame loop */

  // `moved` = nodes that changed position this frame; undefined redraws every edge (first frame).
  const drawEdges = useCallback((moved?: ReadonlySet<string>) => {
    for (const edge of edges) {
      if (moved && !moved.has(edge.from) && !moved.has(edge.to)) continue
      const path = paths.current.get(edge.id)
      const a = springs.current.get(edge.from)
      const b = springs.current.get(edge.to)
      if (!path) continue
      if (!a || !b) continue
      path.setAttribute('d', edgePath({ x: a.x.x, y: a.y.x }, { x: b.x.x, y: b.y.x }, NODE_W, NODE_H))
    }
  }, [edges])

  // The loop stays alive for gestures but writes to the DOM only what moved: an idle graph used to
  // rewrite every node transform and every edge path on every frame (≈20k attribute writes a second
  // on a 350-edge plan), which made the canvas flicker as soon as the tab lost focus or the machine
  // was busy.
  const written = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    let raf = 0
    let last = typeof performance !== 'undefined' ? performance.now() : 0
    let first = true
    let cameraCss = ''
    let mapCss = ''
    const frame = (now: number) => {
      const dt = Math.min(0.032, Math.max(0.001, (now - last) / 1000))
      last = now
      const soft = reducedRef.current
      const moved = new Set<string>()
      for (const [id, target] of targets.current) {
        const el = els.current.get(id)
        let s = springs.current.get(id)
        if (!s) {
          s = { x: spring(target.x), y: spring(target.y) }
          springs.current.set(id, s)
        }
        if (soft || (settled(s.x, target.x) && settled(s.y, target.y))) {
          snap(s.x, target.x)
          snap(s.y, target.y)
        } else {
          springStep(s.x, target.x, dt)
          springStep(s.y, target.y, dt)
        }
        const css = `translate(${s.x.x}px,${s.y.x}px)`
        if (written.current.get(id) !== css) {
          written.current.set(id, css)
          moved.add(id)
          if (el) el.style.transform = css
        } else if (el && el.style.transform !== css) {
          el.style.transform = css
        }
      }
      camera.step(dt, soft)
      const worldCss = camera.transform()
      if (worldRef.current && worldCss !== cameraCss) {
        cameraCss = worldCss
        worldRef.current.style.transform = worldCss
      }
      const mapFrame = mapFrameRef.current
      if (mapFrame) {
        const view = camera.viewBox()
        const p = projectionRef.current
        const left = view.minX * p.scale + p.dx
        const top = view.minY * p.scale + p.dy
        const next = `${Math.max(0, left)}|${Math.max(0, top)}|${Math.min(MAP_W, (view.maxX - view.minX) * p.scale + Math.min(0, left))}|${Math.min(MAP_H, (view.maxY - view.minY) * p.scale + Math.min(0, top))}`
        if (next !== mapCss) {
          mapCss = next
          const [l, t, w, h] = next.split('|')
          mapFrame.style.left = `${l}px`
          mapFrame.style.top = `${t}px`
          mapFrame.style.width = `${w}px`
          mapFrame.style.height = `${h}px`
        }
      }
      if (first) {
        first = false
        drawEdges()
      } else if (moved.size > 0) {
        drawEdges(moved)
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [camera, drawEdges])

  /* ---------------------------------------------------------- viewport */

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      camera.setViewport(rect.width || 960, rect.height || 600)
      // The panel opening or the window narrowing re-fits the plan — unless the reader has already
      // put the camera somewhere on purpose.
      if (fitted.current && !camera.touched) camera.fit(reducedRef.current)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [camera])

  /* ---------------------------------------------------------- motion on change */

  const previous = useRef<Map<string, TaskSnapshot> | null>(null)
  const pending = useRef<Set<string>>(new Set())

  useEffect(() => {
    const before = previous.current
    previous.current = new Map(byId)
    if (!before) return

    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const soft = reducedRef.current
    const ping = (id: string, color: string) => {
      if (hidden) {
        pending.current.add(id)
        return
      }
      const el = els.current.get(id)
      flash(el?.querySelector('.orc-gnode__ping') as HTMLElement | null, color, soft)
      const pos = targets.current.get(id)
      if (pos && !camera.sees({ minX: pos.x, minY: pos.y, maxX: pos.x + NODE_W, maxY: pos.y + NODE_H })) {
        const point = camera.edgePoint({ minX: pos.x, minY: pos.y, maxX: pos.x + NODE_W, maxY: pos.y + NODE_H })
        setOffscreen({ ...point, tone: color })
      }
    }

    const gone: Ghost[] = []
    for (const [id, task] of before) {
      if (byId.has(id)) continue
      const pos = targets.current.get(id) ?? placed.current.get(id)
      if (pos) gone.push({ id, title: task.title, pos })
    }
    if (gone.length > 0) {
      setGhosts((g) => [...g, ...gone])
      setTimeout(() => setGhosts((g) => g.filter((x) => !gone.some((n) => n.id === x.id))), LEAVE_MS)
    }

    for (const [id, task] of byId) {
      const was = before.get(id)
      if (!was) {
        if (!hidden) appear(els.current.get(id)?.querySelector('.orc-gnode__body') ?? null, soft)
        continue
      }
      if (was.status !== 'running' && task.status === 'running') ping(id, 'var(--orc-accent-strong)')
      else if (was.status !== 'accepted' && task.status === 'accepted') ping(id, 'var(--orc-ok)')

      // Unblocking: the light runs along the edge that was just satisfied, then the task wakes up.
      if (was.status === 'blocked' && task.status === 'ready') {
        const freed = task.deps.find((d) => byId.get(d)?.status === 'accepted' && before.get(d)?.status !== 'accepted')
        const path = freed ? (paths.current.get(`${freed}>${id}`) ?? null) : null
        if (path && !hidden) lightEdge(path, soft, () => ping(id, 'var(--orc-accent)'))
        else ping(id, 'var(--orc-accent)')
      }
    }
  }, [byId, camera])

  // Trouble that appears between snapshots gets its own single red ping — never one per feed line.
  const knownAlerts = useRef<Set<string> | null>(null)
  useEffect(() => {
    const before = knownAlerts.current
    knownAlerts.current = new Set(alerts)
    if (!before) return
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    for (const id of alerts) {
      if (before.has(id)) continue
      if (hidden) {
        pending.current.add(id)
        continue
      }
      flash((els.current.get(id)?.querySelector('.orc-gnode__ping') as HTMLElement | null) ?? null, 'var(--orc-error)', reducedRef.current)
    }
  }, [alerts])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  useEffect(() => {
    if (!offscreen) return
    const t = setTimeout(() => setOffscreen(null), OFFSCREEN_MS)
    return () => clearTimeout(t)
  }, [offscreen])

  // Changes while away: what moved while the tab was hidden is outlined for a few seconds.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || pending.current.size === 0) return
      const ids = new Set(pending.current)
      pending.current = new Set()
      setAway(ids)
      setTimeout(() => setAway(new Set()), AWAY_MS)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  /* ---------------------------------------------------------- camera gestures */

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Controls inside the canvas (toolbar chips, search, the minimap) must keep their own
    // pointer: capturing it here would retarget the click and make every button dead.
    if (event.button !== 0 || (event.target as HTMLElement).closest('.orc-gnode, .orc-gtools, button, a, input, select')) return
    canvasRef.current?.setPointerCapture?.(event.pointerId)
    camera.beginDrag(event.clientX, event.clientY, event.timeStamp)
  }
  /** Empty canvas clears the selection. */
  const onCanvasClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (camera.dragging || suppressClick.current) return
    if ((event.target as HTMLElement).closest('.orc-gnode, .orc-gtools, .orc-gfan, button, a, input, select')) return
    onSelect(null)
    const active = document.activeElement as HTMLElement | null
    if (active && canvasRef.current?.contains(active)) active.blur()
  }
  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (camera.dragging) camera.drag(event.clientX, event.clientY, event.timeStamp)
    if (drag.current) moveNode(event.clientX, event.clientY)
  }
  const endCanvasDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (camera.dragging) camera.endDrag(reducedRef.current, event.timeStamp)
    if (drag.current) dropNode()
    canvasRef.current?.releasePointerCapture?.(event.pointerId)
  }
  // macOS conventions (Figma, Miro, Maps): two fingers move the canvas; a pinch (delivered as a wheel
  // event with ctrlKey) or ⌘ + scroll zooms, proportionally to the gesture rather than in fixed steps.
  // A native non-passive listener: React's onWheel is passive, so preventDefault could not stop the
  // browser from zooming or scrolling the whole dsh page.
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect()
        const factor = Math.exp(-Math.max(-50, Math.min(50, event.deltaY)) * 0.01)
        camera.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor)
        return
      }
      camera.panBy(-event.deltaX, -event.deltaY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [camera])

  /* ---------------------------------------------------------- node dragging = pinning */

  const manualPos = (id: string): ManualPos => overrideRef.current.has(id) ? overrideRef.current.get(id) ?? null : byId.get(id)?.pos ?? null
  const applyMoves = (moves: Move[], record: boolean, tidy?: string | true) => {
    if (!moves.length) return
    if (record) {
      history.current.undo.push({ moves, scope: tidy })
      if (history.current.undo.length > 30) history.current.undo.shift()
      history.current.redo = []
    }
    const nextOverrides = new Map(overrideRef.current)
    for (const move of moves) {
      nextOverrides.set(move.id, move.after)
      expected.current.set(move.id, [...(expected.current.get(move.id) ?? []), move.after])
    }
    overrideRef.current = nextOverrides
    setOverrides(nextOverrides)
    const version = ++layoutVersion.current
    if (decision.folded.size > 0) {
      setFitNonce((n) => n + 1)
    } else void layoutGraph(tasks.map((task) => ({ ...task, pos: undefined }))).then((computed) => {
      if (currentPlan !== planRef.current || version !== layoutVersion.current) return
      const next = new Map(placed.current)
      if (tidy === true && moves.every((move) => !move.after)) {
        for (const [id, pos] of computed) next.set(id, pos)
      } else if (typeof tidy === 'string' && moves.every((move) => !move.after)) {
        for (const task of tasks.filter((t) => laneOf(t) === tidy)) {
          const pos = computed.get(task.id)
          if (pos) next.set(task.id, pos)
        }
      } else {
        for (const move of moves) {
          const task = byId.get(move.id)
          const pos = move.after ? { ...move.after, lane: task ? laneOf(task) : '' } : computed.get(move.id)
          if (pos) next.set(move.id, pos)
        }
      }
      layoutOverride.current = next
      placed.current = next
      setNodes(next)
      setFitNonce((n) => n + 1)
      if (tidy === true) requestAnimationFrame(() => {
        const selected = selectedId ? next.get(selectedId) : undefined
        if (selected) camera.centerOn(selected.x + NODE_W / 2, selected.y + NODE_H / 2, reducedRef.current)
        else camera.fit(reducedRef.current)
      })
    })
    writeQueue.current = writeQueue.current.then(async () => {
      if (currentPlan !== planRef.current) return
      try {
        const result = await api.positions(shown.root, shown.planId ?? 'main', revisionRef.current, moves.map((move) => ({ task: move.id, pos: move.after })))
        if (!result.ok) { setNote(t('graph.saveLayoutFailed')); history.current.redo = [] }
        else revisionRef.current++
      } catch { setNote(t('graph.saveLayoutFailed')); history.current.redo = [] }
    })
  }

  const tidy = (lane?: string) => {
    const moves = tasks.filter((task) => (!lane || laneOf(task) === lane) && manualPos(task.id)).map((task) => ({ id: task.id, before: manualPos(task.id), after: null }))
    applyMoves(moves, true, lane ?? true)
  }

  useEffect(() => {
    const onUndo = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      if (target instanceof Element && target.closest('input,textarea,[contenteditable="true"]')) return
      const source = event.shiftKey ? history.current.redo : history.current.undo
      const destination = event.shiftKey ? history.current.undo : history.current.redo
      const entry = source.pop()
      if (!entry) return
      event.preventDefault()
      destination.push(entry)
      const moves = event.shiftKey ? entry.moves : entry.moves.map((move) => ({ id: move.id, before: move.after, after: move.before }))
      applyMoves(moves, false, entry.scope)
    }
    document.addEventListener('keydown', onUndo)
    return () => document.removeEventListener('keydown', onUndo)
  })

  const drag = useRef<{ id: string; pointerId: number; sx: number; sy: number; origin: NodePos; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  const moveNode = (clientX: number, clientY: number) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.abs(clientX - d.sx) < DRAG_SLOP && Math.abs(clientY - d.sy) < DRAG_SLOP) return
    // Capture only once the gesture is really a drag: capturing on press would retarget the click
    // away from the node's button and break plain selection.
    if (!d.moved) canvasRef.current?.setPointerCapture?.(d.pointerId)
    d.moved = true
    const next: NodePos = { ...d.origin, x: d.origin.x + (clientX - d.sx) / camera.scale, y: d.origin.y + (clientY - d.sy) / camera.scale }
    targets.current.set(d.id, next)
    const s = springs.current.get(d.id)
    if (s) {
      snap(s.x, next.x)
      snap(s.y, next.y)
    }
  }

  const dropNode = () => {
    const d = drag.current
    drag.current = null
    if (!d?.moved) return
    suppressClick.current = true
    const next = targets.current.get(d.id)
    if (!next) return
    // The drop is free: a node stays where the hand left it, and the lane band grows around it
    // (`laneBands` derives the band from its nodes). Confining the drop to the band read as the
    // graph fighting the hand; order comes back from tidy controls, not from
    // a rubber band that undoes the gesture.
    applyMoves([{ id: d.id, before: manualPos(d.id), after: { x: Math.round(next.x), y: Math.round(next.y) } }], true)
  }

  const onNodePointerDown = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (event.button !== 0) return
    const origin = targets.current.get(id)
    if (!origin) return
    drag.current = { id, pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, origin, moved: false }
  }

  const unpin = (id: string) => {
    applyMoves([{ id, before: manualPos(id), after: null }], true)
  }

  const focusNeighbours = (id: string) => {
    const ids = [id, ...(byId.get(id)?.deps ?? []), ...tasks.filter((t) => t.deps.includes(id)).map((t) => t.id)]
    const spots = ids.map((x) => targets.current.get(x)).filter((p): p is NodePos => !!p)
    if (spots.length === 0) return
    camera.focus(
      {
        minX: Math.min(...spots.map((p) => p.x)),
        minY: Math.min(...spots.map((p) => p.y)),
        maxX: Math.max(...spots.map((p) => p.x)) + NODE_W,
        maxY: Math.max(...spots.map((p) => p.y)) + NODE_H,
      },
      reducedRef.current,
    )
  }

  /* ---------------------------------------------------------- keyboard */

  const focusNode = (id: string) => {
    onSelect(id)
    requestAnimationFrame(() => (els.current.get(id)?.querySelector('.orc-gnode__body') as HTMLElement | null)?.focus())
  }

  /** A search hit is selected, flown to and focused — three steps the reader asked for with one Enter. */
  const pickFound = (id: string) => {
    setSearching(false)
    const pos = targets.current.get(id) ?? (byId.get(id) && targets.current.get(`lane:${laneOf(byId.get(id)!)}`))
    if (pos) camera.centerOn(pos.x + NODE_W / 2, pos.y + NODE_H / 2, reducedRef.current)
    focusNode(id)
  }

  const step = (direction: 'left' | 'right' | 'up' | 'down') => {
    if (!selectedId) return
    if (direction === 'right') {
      const next = tasks.find((t) => t.deps.includes(selectedId))
      if (next) focusNode(next.id)
      return
    }
    if (direction === 'left') {
      const dep = byId.get(selectedId)?.deps.find((d) => byId.has(d))
      if (dep) focusNode(dep)
      return
    }
    const here = targets.current.get(selectedId)
    if (!here) return
    const column = [...targets.current.entries()]
      .filter(([, p]) => Math.abs(p.x - here.x) < NODE_W / 2)
      .sort((a, b) => a[1].y - b[1].y)
      .map(([id]) => id)
    const index = column.indexOf(selectedId)
    const next = column[index + (direction === 'down' ? 1 : -1)]
    if (next) focusNode(next)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && fanLane) {
      event.preventDefault()
      setFanLane(null)
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const task = selectedId ? byId.get(selectedId) : undefined
    const key = event.key
    const map: Record<string, 'left' | 'right' | 'up' | 'down'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
    if (map[key]) {
      event.preventDefault()
      step(map[key])
      return
    }
    // The Russian layout puts these actions on the same physical keys.
    if (key === 'f' || key === 'F' || key === '\u0430' || key === '\u0410') {
      event.preventDefault()
      camera.fit(reducedRef.current)
      return
    }
    if ((key === 'r' || key === 'R' || key === '\u043a' || key === '\u041a') && task?.status === 'ready') {
      event.preventDefault()
      setNote(t('graph.startingTask', { task: task.title }))
      void api.run(shown.root, task.id).then((r) => setNote(r.ok ? null : t('graph.startTaskFailed')))
      return
    }
    if ((key === 's' || key === 'S' || key === '\u044b' || key === '\u042b') && task?.status === 'running') {
      event.preventDefault()
      onSelect(task.id)
      // The steer field lives in the task panel (Task 3); the graph only hands focus over to it.
      requestAnimationFrame(() => {
        const button = [...(document.querySelectorAll<HTMLButtonElement>('.orc-panel button') ?? [])].find((b) =>
          b.textContent?.startsWith(t('graph.steerButtonPrefix')))
        button?.focus()
        button?.click()
      })
    }
  }

  /* ---------------------------------------------------------- render */

  const chain = useMemo(() => {
    const ids = chainOf(hovered ?? selectedId, tasks)
    for (const id of [...ids]) if (!graph.nodes.some((n) => n.id === id) && byId.get(id)) ids.add(`lane:${laneOf(byId.get(id)!)}`)
    return ids
  }, [hovered, selectedId, tasks, graph.nodes, byId])
  const criticalSet = useMemo(() => new Set(critical ? shown.criticalPath.map((id) => graph.nodes.some((n) => n.id === id) ? id : byId.get(id) ? `lane:${laneOf(byId.get(id)!)}` : id) : []), [critical, shown.criticalPath, graph.nodes, byId])
  const mapNodes = useMemo<MapNode[]>(
    () =>
      graph.nodes.flatMap((node) => {
        const pos = nodes.get(node.id)
        const matches = visibleMatchIds.has(node.id)
        return pos ? [{ id: node.id, pos, color: node.task ? taskTone(node.task).color : 'var(--orc-ok)', on: node.id === selectedId, dim: lensOn && !matches }] : []
      }),
    [graph.nodes, nodes, selectedId, lensOn, visibleMatchIds],
  )
  const now = new Date()

  if (tasks.length === 0) {
    return <p className="orc-empty">{t('graph.noTasks')}</p>
  }

  const faded = (id: string) => (chain.size > 0 && !chain.has(id)) || (criticalSet.size > 0 && !criticalSet.has(id))
  const showFan = (lane: string, pointer: boolean) => {
    if (fanTimer.current) clearTimeout(fanTimer.current)
    if (fanRemoveTimer.current) clearTimeout(fanRemoveTimer.current)
    setFanPointer(pointer)
    setFanClosing(false)
    setFanLane(lane)
  }
  const closeFan = () => {
    if (fanTimer.current) clearTimeout(fanTimer.current)
    fanTimer.current = setTimeout(() => {
      if (reducedRef.current || !fanPointer) setFanLane(null)
      else {
        setFanClosing(true)
        fanRemoveTimer.current = setTimeout(() => setFanLane(null), 160)
      }
    }, 350)
  }
  const fanTasks = fanLane ? tasks.filter((task) => laneOf(task) === fanLane) : []
  const fanChip = fanLane ? nodes.get(`lane:${fanLane}`) : undefined
  const fan = fanChip && fanTasks.length ? fanPosition(fanChip, fanTasks.length, nodes, bands) : null

  return (
    <div className="orc-graph-wrap">
      {/* The canvas is a pan surface, not a control: everything it does also has a button or a key. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper handles delegated pointer or keyboard events for its child controls. */} <div
        ref={canvasRef}
        className="orc-graph"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={endCanvasDrag}
        onPointerCancel={endCanvasDrag}
        onClick={onCanvasClick}
        onKeyDown={onKeyDown}
      >
        <div ref={worldRef} className="orc-gworld">
          {bands.map((band) => (
            <div
              key={band.lane || '—'}
              className="orc-glane"
              style={{ left: laneLeft, top: band.top, width: box.maxX - laneLeft + 22, height: band.height }}
            >
              {band.lane && !band.folded ? <div className="orc-glane__head"><b>{laneTitle(band.lane)}</b><button type="button" onClick={() => toggleFold(band.lane)} aria-label={t('graph.collapseLane', { lane: laneTitle(band.lane) })}>{t('graph.collapse')}</button><button type="button" onClick={() => tidy(band.lane)} aria-label={t('graph.tidyLane', { lane: laneTitle(band.lane) })}>{t('graph.tidyHere')}</button></div> : null}
            </div>
          ))}

          <svg className="orc-gedges" width="1" height="1" aria-hidden="true">
            <defs>
              {(['ok', 'wait', 'bad'] as const).map((state) => (
                <marker key={state} id={`orc-arrow-${state}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto">
                  <path d="M0 0L8 4L0 8z" className={`orc-garrow orc-garrow--${state}`} />
                </marker>
              ))}
            </defs>
            {edges.map((edge) => (
              <path
                key={edge.id}
                ref={(el) => {
                  if (el) paths.current.set(edge.id, el)
                  else paths.current.delete(edge.id)
                }}
                className={`orc-gedge orc-gedge--${edge.state}${chain.size > 0 && chain.has(edge.from) && chain.has(edge.to) ? ' orc-gedge--on' : ''}${
                  chain.size > 0 && !(chain.has(edge.from) && chain.has(edge.to)) ? ' orc-gedge--off' : ''
                }${lensOn && !visibleMatchIds.has(edge.from) && !visibleMatchIds.has(edge.to) ? ' orc-gedge--dim' : ''}`}
                markerEnd={`url(#orc-arrow-${edge.state})`}
              ><title>{t('graph.edgeCount', { count: edge.count })}</title></path>
            ))}
          </svg>

          {ghosts.map((ghost) => (
            <div key={`ghost-${ghost.id}`} className="orc-gnode orc-gnode--ghost" style={{ transform: `translate(${ghost.pos.x}px,${ghost.pos.y}px)` }}>
              <span
                className="orc-gnode__body"
                ref={(el) => {
                  if (el) leave(el, reducedRef.current)
                }}
              >
                <span className="orc-gnode__title">{ghost.title}</span>
              </span>
            </div>
          ))}

          {fan && fanLane ? /* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper handles delegated pointer or keyboard events for its child controls. */ <div className={`orc-gfan${fanPointer && !reduced ? ' orc-gfan--motion' : ''}${fanClosing ? ' orc-gfan--closing' : ''}`} data-side={fan.side} data-lane={fanLane} style={{ left: fan.x, top: fan.y }} onPointerEnter={() => showFan(fanLane, true)} onPointerLeave={closeFan} onFocus={() => showFan(fanLane, false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeFan() }}>
            {fanTasks.map((task, index) => <button type="button" key={task.id} className="orc-gfan__card" style={{ transform: `translateY(${index * FAN_ROW_H}px)` }} onClick={() => { onSelect(task.id); setFanLane(null) }} aria-label={t('graph.selectTask', { id: task.id, title: task.title })}><span className="orc-gfan__id">{task.id}</span><span className="orc-gfan__title">{task.title}</span></button>)}
          </div> : null}

          {graph.nodes.map((node) => {
            const task = node.task
            const pos = nodes.get(node.id)
            if (!pos) return null
            if (!task) return /* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper handles delegated pointer or keyboard events for its child controls. */ <div key={node.id} ref={(el) => { if (el) els.current.set(node.id, el); else els.current.delete(node.id) }} className={`orc-gnode orc-gnode--lane${lensOn && !visibleMatchIds.has(node.id) ? ' orc-gnode--dim' : ''}`} style={{ transform: `translate(${pos.x}px,${pos.y}px)`, width: NODE_W }} onPointerEnter={() => showFan(node.lane, true)} onPointerLeave={closeFan} onFocus={() => showFan(node.lane, false)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) closeFan() }}>
              <button type="button" className="orc-gnode__body orc-gnode__body--lane" aria-label={t('graph.expandLane', { lane: laneTitle(node.lane) })} aria-expanded="false" onClick={() => toggleFold(node.lane)}>
                <span className="orc-gnode__title">{laneTitle(node.lane) || t('graph.unnamedLane')} <span aria-hidden="true">⌄</span></span>
                <span className="orc-gnode__meta"><em>{taskCount(node.count ?? 0)} · {node.summary}</em></span>
              </button>
            </div>
            const tone = taskTone(task)
            const identity = workerIdentity(task.worker, workers)
            const fact = runFact(task, now)
            const negativePredecessor = task.deps.some((id) => byId.get(id)?.closed === 'negative')
            const outcome = task.closed === 'negative' ? t('graph.negativeResult') : negativePredecessor ? t('graph.negativePredecessor') : null
            const attention = attentionOf.get(task.id)
            const alert = attention?.severity === 'alert'
            const waiting = reviewIds.has(task.id)
            return (
              <div
                key={task.id}
                data-task-id={task.id}
                ref={(el) => {
                  if (el) els.current.set(task.id, el)
                  else els.current.delete(task.id)
                }}
                className={`orc-gnode${node.guest ? ' orc-gnode--guest' : ''}${faded(task.id) ? ' orc-gnode--faded' : ''}${away.has(task.id) ? ' orc-gnode--away' : ''}${waiting ? ' orc-gnode--review' : ''}${
                  lensOn && !matchIds.has(task.id) ? ' orc-gnode--dim' : ''
                }`}
                style={{ transform: `translate(${pos.x}px,${pos.y}px)`, width: NODE_W }}
              >
                <button
                  type="button"
                  className={`orc-gnode__body${task.status === 'blocked' || task.status === 'backlog' ? ' orc-gnode__body--dim' : ''}${
                    task.kind === 'decision' ? ' orc-gnode__body--decision' : ''
                  }`}
                  aria-pressed={selectedId === task.id}
                  aria-label={`${task.title} · ${tone.label} · ${identityLabel(identity)} · ${fact}${outcome && outcome !== tone.label ? ` · ${outcome}` : ''}`}
                  title={`${tone.label} · ${identityLabel(identity)} · ${fact}${outcome && outcome !== tone.label ? ` · ${outcome}` : ''}`}
                  tabIndex={selectedId === task.id || (!selectedId && tasks[0]?.id === task.id) ? 0 : -1}
                  onPointerDown={(event) => onNodePointerDown(event, task.id)}
                  onPointerEnter={() => setHovered(task.id)}
                  onPointerLeave={() => setHovered((h) => (h === task.id ? null : h))}
                  onFocus={() => setHovered(null)}
                  onClick={() => {
                    if (suppressClick.current) {
                      suppressClick.current = false
                      return
                    }
                    onSelect(task.id)
                  }}
                  onDoubleClick={() => (task.pos ? unpin(task.id) : focusNeighbours(task.id))}
                >
                  <span className={`orc-gnode__strip orc-gnode__strip--${task.status}`} style={{ backgroundColor: tone.color }} aria-hidden="true" />
                  <span className="orc-gnode__title">
                    {task.kind === 'decision' ? <span aria-hidden="true">◆ </span> : null}
                    {density === 'detail' ? <span className="orc-card__id">{task.id} </span> : null}
                    {task.title}
                    {node.guest ? <span className="orc-gnode__guest-label">{node.lane}</span> : null}
                  </span>
                  <span className="orc-gnode__meta">
                    <VendorMark identity={identity} />
                    <span className="orc-gnode__model">{identityLabel(identity)}</span>
                    <span className="orc-gnode__fact">{outcome ?? (task.status === 'in_review' && isChecking(task.check) ? tone.label : fact)}</span>
                    {isHandPicked(task) ? <span className="orc-gnode__hand" role="img" aria-label={t('graph.handPicked')} title={t('graph.handPickedTitle')}>⚑</span> : null}
                  </span>
                  {task.pos ? (
                    <span className="orc-gnode__pin" role="img" aria-label={t('graph.pinned')}>
                      ⊙
                    </span>
                  ) : null}
                  {alert ? (
                    <span className="orc-gnode__badge" role="img" aria-label={t('graph.attention')}>
                      !
                    </span>
                  ) : null}
                  {negativePredecessor ? <span className="orc-gnode__dep" role="img" aria-label={t('graph.negativePredecessor')} title={t('graph.negativePredecessorTitle')}>!</span> : null}
                </button>
                {waiting ? (
                  // The badge does what it says: the same accept call as the panel, confirmed in the
                  // macOS window. Selecting the task first keeps the panel in context behind it.
                  <button
                    type="button"
                    className="orc-gnode__review"
                    aria-label={t('graph.acceptWork', { title: task.title })}
                    title={t('graph.acceptHint')}
                    disabled={accept.pending}
                    onClick={() => {
                      onSelect(task.id)
                      void accept.call(() => api.accept(repo.root, task.id))
                    }}
                  >
                    ◐ {t('graph.acceptMore')}
                  </button>
                ) : null}
                <span className="orc-gnode__ping" aria-hidden="true" />
              </div>
            )
          })}
        </div>

        {offscreen ? <span className="orc-gedge-mark" style={{ left: offscreen.x, top: offscreen.y, background: offscreen.tone }} aria-hidden="true" /> : null}

        {searching ? <GraphSearch tasks={tasks} onPick={pickFound} onClose={() => setSearching(false)} /> : null}

        <Minimap box={box} nodes={mapNodes} frameRef={mapFrameRef} onJump={(world, dragging) => camera.centerOn(world.x, world.y, dragging)} />

        <div className="orc-gtools">
          <button type="button" className="orc-chip" onClick={() => tidy()} disabled={!tasks.some((task) => manualPos(task.id))}>{t('graph.tidyAll')}</button>
          <button type="button" className="orc-chip" onClick={() => camera.fit(reducedRef.current)}>
            <span aria-hidden="true">⤢</span> {t('graph.fit')}
          </button>
          <button type="button" className="orc-chip" aria-pressed={critical} onClick={() => setCritical(!critical)}>
            {t('graph.criticalPath', { count: shown.criticalPath.length })}
          </button>
          <div className="orc-seg orc-graph-density" role="radiogroup" aria-label={t('panel.app.density')}>
            {/* biome-ignore lint/a11y/useSemanticElements: This custom control keeps its established layout and keyboard behavior. */} <button type="button" role="radio" className="orc-seg__item" aria-checked={density === 'overview'} onClick={() => { if (density !== 'overview') toggleDensity?.() }}>{t('panel.app.overview')}</button>
            <button type="button" role="radio" className="orc-seg__item" aria-checked={density === 'detail'} onClick={() => { if (density !== 'detail') toggleDensity?.() }}>{t('panel.app.detail')}</button>
          </div>
          <span className={`orc-lens${lens === 'review' ? ' orc-lens--on' : ''}`}>
            <button
              type="button"
              className="orc-chip"
              aria-pressed={lens === 'review'}
              disabled={reviewIds.size === 0}
              title={t('graph.reviewLensHint')}
              onClick={() => setLens?.(lens === 'review' ? null : 'review')}
            >
              <span aria-hidden="true">◐</span> {reviewIds.size > 0 ? t('graph.reviewLensCount', { count: reviewIds.size }) : t('graph.reviewLens')}
            </button>
            {lens === 'review' && lensStep && reviewIds.size > 1 ? (
              <button type="button" className="orc-chip orc-lens__go" title={t('graph.nextLensHint')} aria-label={t('graph.nextLens')} onClick={() => lensStep(1)}>
                ›
              </button>
            ) : null}
          </span>
          <button type="button" className="orc-chip" aria-pressed={searching} onClick={() => setSearching((open) => !open)}>
            <span aria-hidden="true">⌕</span> {t('graph.find')}
          </button>
          <span className="orc-ghint">{t('graph.gestureHint')}</span>
        </div>
        {note ? (
          <p className="orc-gnote" role="status">
            {note}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export const GraphView = memo(GraphViewImpl, (a, b) => JSON.stringify(a.repo) === JSON.stringify(b.repo) && a.workers === b.workers && a.selectedId === b.selectedId && a.onSelect === b.onSelect && a.density === b.density && a.lens === b.lens && a.setLens === b.setLens && a.walk === b.walk && a.lensStep === b.lensStep && a.camera === b.camera)
