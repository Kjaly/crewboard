/**
 * elkjs weighs about three megabytes — more than the whole screen. The plan is readable without it
 * (dependency levels give the same left→right reading), so ELK is never part of the first byte:
 * `lib/elk.js` is a separate bundle, fetched once the graph is actually on screen, and the move from
 * the level layout to the ELK one is a spring, not a jump.
 */

export type ElkEngine = { layout(graph: unknown): Promise<unknown> }
type ElkGlobal = { __orchElk?: new () => ElkEngine }

/** Served next to the client bundle by the dsh module server (package export `./elk.js`). */
// Served by the plugin host (src/host/assets.ts): dsh itself serves only the declared client bundle.
export const ELK_URL = '/crewboard/assets/elk.js'

let engine: ElkEngine | undefined
let loading: Promise<boolean> | undefined

export const elkEngine = (): ElkEngine | undefined => engine
export const elkReady = (): boolean => engine !== undefined

/** The separate bundle publishes the constructor on one global; picking it up is all that is left. */
function adopt(): boolean {
  if (engine) return true
  const ctor = (globalThis as unknown as ElkGlobal).__orchElk
  if (!ctor) return false
  try {
    engine = new ctor()
  } catch {
    return false
  }
  return true
}

/**
 * @returns true once the precise layout engine is in memory. False is not an error: it means the
 *   graph keeps the level layout, which is a complete answer, just a rougher one.
 */
export function loadElk(url: string = ELK_URL): Promise<boolean> {
  if (adopt()) return Promise.resolve(true)
  if (typeof document === 'undefined') return Promise.resolve(false)
  loading ??= new Promise<boolean>((resolve) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.dataset.orchestraElk = ''
    script.addEventListener('load', () => resolve(adopt()))
    script.addEventListener('error', () => resolve(false))
    document.head.append(script)
  })
  return loading
}

/** Tests and the fake-data stand hand the engine over directly instead of loading a bundle. */
export function setElkEngine(next: ElkEngine | undefined): void {
  engine = next
  loading = undefined
}
