/** Browser hash route for the orchestration screen. This module has no dsh runtime dependency. */
export type RouteView = 'graph' | 'work' | 'review' | 'settings'
export type OrchestraRoute = {
  repo: string
  plan: string
  view: RouteView
  task?: string
  tab?: string
  draft?: string
  run?: string
  step?: string
  lens?: string
  /** The lane the plan opens focused on: the graph flies to it, Work and Review filter to it. */
  lane?: string
}

const PREFIX = '#orchestra/'
const VIEWS = new Set<RouteView>(['graph', 'work', 'review', 'settings'])
const decode = (part: string): string | undefined => {
  try { return decodeURIComponent(part) } catch { return undefined }
}

export function parseRoute(hash: string): OrchestraRoute | null {
  if (!hash.startsWith(PREFIX)) return null
  const [path, query = ''] = hash.slice(PREFIX.length).split('?', 2)
  const parts = path.split('/').map(decode)
  if (parts.length < 3 || parts.some((part) => part === undefined || part.length === 0)) return null
  const [repo, plan, view, task, tab] = parts as string[]
  if (tab && !task) return null
  const params = new URLSearchParams(query)
  const draft = params.get('draft') || undefined
  const run = params.get('run') || undefined
  const step = params.get('step') || undefined
  const lens = params.get('lens') || undefined
  // The unnamed lane is a real lane: `?lane=` (empty) addresses it, so presence decides, not truthiness.
  const lane = params.has('lane') ? params.get('lane') ?? '' : undefined
  if (draft && run) return null
  if (step && !run) return null
  return { repo, plan, view: VIEWS.has(view as RouteView) ? view as RouteView : 'graph', ...(task ? { task } : {}), ...(tab ? { tab } : {}), ...(draft ? { draft } : {}), ...(run ? { run } : {}), ...(step ? { step } : {}), ...(lens ? { lens } : {}), ...(lane !== undefined ? { lane } : {}) }
}

export function formatRoute(route: OrchestraRoute): string {
  const encode = (value: string) => encodeURIComponent(value)
  const path = [route.repo, route.plan, route.view, ...(route.task ? [route.task] : []), ...(route.task && route.tab ? [route.tab] : [])].map(encode).join('/')
  const query = new URLSearchParams()
  if (route.draft) query.set('draft', route.draft)
  if (route.run) query.set('run', route.run)
  if (route.run && route.step) query.set('step', route.step)
  if (route.lens) query.set('lens', route.lens)
  if (route.lane !== undefined) query.set('lane', route.lane)
  return `${PREFIX}${path}${query.size ? `?${query}` : ''}`
}

export type RouteControllerOptions = {
  read(): OrchestraRoute | null
  apply(route: OrchestraRoute): void
  selectPanel(): boolean
  onLeave?(): void
  window?: Window
}

/** Synchronizes app state and browser history. Caller owns route classification and store mapping. */
export function createRouteController(options: RouteControllerOptions) {
  const win = options.window ?? window
  let applying = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const applyHash = () => {
    const route = parseRoute(win.location.hash)
    if (!route) { if (!win.location.hash.startsWith(PREFIX)) options.onLeave?.(); return }
    applying = true
    try { options.apply(route) } finally { queueMicrotask(() => { applying = false }) }
  }
  const selectWhenReady = () => {
    if (options.selectPanel()) return
    retryTimer = setTimeout(selectWhenReady, 50)
  }
  const onPop = () => { if (parseRoute(win.location.hash)) { if (retryTimer) clearTimeout(retryTimer); selectWhenReady() } applyHash() }
  return {
    start(): () => void {
      if (parseRoute(win.location.hash)) { selectWhenReady(); applyHash() }
      win.addEventListener('popstate', onPop)
      win.addEventListener('hashchange', onPop)
      return () => { win.removeEventListener('popstate', onPop); win.removeEventListener('hashchange', onPop); if (retryTimer) clearTimeout(retryTimer) }
    },
    write(route: OrchestraRoute, mode: 'push' | 'replace'): void {
      if (applying) return
      const hash = formatRoute(route)
      if (win.location.hash === hash) return
      win.history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', hash)
    },
    leave(): void {
      if (win.location.hash.startsWith(PREFIX)) win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}`)
    },
  }
}
