// Structural client faces. Keep the browser bundle free of dsh runtime imports.
export type SlotsFace = {
  inject(slot: string, fn: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): () => void
}
export type LanguageRegistration = { id: string; label: string; fallback: string }
export type ClientServices = {
  layout: { selectPanel(key: string): void }
  uiWorkspace: { openSession(sessionId: string): void | Promise<void> }
  locale: {
    getSnapshot(): { active: string }
    subscribe(fn: () => void): () => void
    addLanguage(input: LanguageRegistration): () => void
  }
}
export type ClientContext = {
  get?(name: string): unknown
  inject?(names: readonly string[], fn: (child: unknown) => void): void
  effect?(fn: () => (() => void) | undefined, label?: string): void
  on?(event: string, listener: (...args: unknown[]) => void): void
}

export type BoundaryDiagnostic = { side: 'client' | 'host'; service: string; kind: 'shape' | 'access' | 'callback'; error?: unknown }
const reported = new Set<string>()
export function reportBoundary(record: BoundaryDiagnostic): void {
  const key = `${record.side}:${record.service}:${record.kind}`
  if (reported.has(key)) return
  reported.add(key)
  console.warn('[crewboard] dsh service boundary', record)
}

const valid = {
  layout: (value: unknown): value is ClientServices['layout'] => !!value && typeof (value as ClientServices['layout']).selectPanel === 'function',
  uiWorkspace: (value: unknown): value is ClientServices['uiWorkspace'] => !!value && typeof (value as ClientServices['uiWorkspace']).openSession === 'function',
  locale: (value: unknown): value is ClientServices['locale'] => {
    const face = value as ClientServices['locale'] | undefined
    return !!face && typeof face.getSnapshot === 'function' && typeof face.subscribe === 'function' && typeof face.addLanguage === 'function'
  },
}

/** Optional absence waits for a future injection; a present malformed face is diagnosed once. */
export function bindClientService<K extends keyof ClientServices>(
  ctx: ClientContext,
  name: K,
  onAvailable: (face: ClientServices[K]) => void | (() => void),
): () => void {
  let cleanup: (() => void) | void
  let face: ClientServices[K] | undefined
  let closed = false
  const release = () => { cleanup?.(); cleanup = undefined; face = undefined }
  const adopt = (child: unknown) => {
    let value: unknown
    try { value = (child as Record<string, unknown>)[name] }
    catch (error) { reportBoundary({ side: 'client', service: name, kind: 'access', error }); return }
    if (value == null) return
    if (!valid[name](value)) { reportBoundary({ side: 'client', service: name, kind: 'shape' }); return }
    if (closed || face === value) return
    release()
    face = value as ClientServices[K]
    try { cleanup = onAvailable(face) }
    catch (error) { release(); reportBoundary({ side: 'client', service: name, kind: 'callback', error }) }
    (child as ClientContext).effect?.(() => () => { if (face === value) release() }, `crewboard: ${name}`)
  }
  try { ctx.inject?.([name], adopt) }
  catch (error) { reportBoundary({ side: 'client', service: name, kind: 'access', error }) }
  ctx.effect?.(() => () => { closed = true; release() }, `crewboard: ${name} binding`)
  return () => { closed = true; release() }
}
