import type { HostContext } from './dsh.js'

type SettingsFace = { get(namespace: string): unknown }
type HostServices = { settings: SettingsFace }
const reported = new Set<string>()
export function reportHostBoundary(service: string, kind: 'shape' | 'access' | 'callback', error?: unknown): void {
  const key = `${service}:${kind}`
  if (reported.has(key)) return
  reported.add(key)
  console.warn('[crewboard] dsh service boundary', { side: 'host', service, kind, error })
}

/** A granted child owns the reference; disposal drops it before a replacement can be used. */
export function bindHostService<K extends keyof HostServices>(
  ctx: HostContext,
  name: K,
  onAvailable: (face: HostServices[K]) => void | (() => void),
): void {
  let face: HostServices[K] | undefined
  let cleanup: (() => void) | void
  const release = () => { cleanup?.(); cleanup = undefined; face = undefined }
  try {
    ctx.inject([name], (child) => {
      let value: unknown
      try { value = (child as unknown as Record<string, unknown>)[name] }
      catch (error) { reportHostBoundary(name, 'access', error); return }
      if (value == null) return
      if (typeof (value as SettingsFace).get !== 'function') { reportHostBoundary(name, 'shape'); return }
      if (face === value) return
      release()
      face = value as HostServices[K]
      try { cleanup = onAvailable(face) }
      catch (error) { release(); reportHostBoundary(name, 'callback', error) }
      child.effect(() => () => { if (face === value) release() }, `crewboard: ${name}`)
    })
  } catch (error) { reportHostBoundary(name, 'access', error) }
  ctx.effect(() => release, `crewboard: ${name} binding`)
}
