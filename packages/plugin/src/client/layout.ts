import { bindClientService, type ClientContext, type ClientServices } from './dsh.js'

let resolved: ClientServices['layout'] | undefined
let stop: (() => void) | undefined

/** Resolve the optional layout capability only inside its granted injection. */
export function bindLayout(ctx: ClientContext): void {
  stop?.()
  stop = bindClientService(ctx, 'layout', (face) => {
    resolved = face
    return () => { if (resolved === face) resolved = undefined }
  })
}

/** Switch the central area to a registered main panel. Returns false when the shell refused. */
export function selectMainPanel(key: string): boolean {
  try {
    if (!resolved) return false
    resolved.selectPanel(key)
    return true
  } catch {
    // A panel can disappear before selection; the toast remains usable.
    return false
  }
}

export function resetLayout(): void { stop?.(); stop = undefined; resolved = undefined }

let workspace: ClientServices['uiWorkspace'] | undefined
export function bindWorkspace(ctx: ClientContext): void {
  bindClientService(ctx, 'uiWorkspace', (face) => { workspace = face; return () => { if (workspace === face) workspace = undefined } })
}
export async function openSession(sessionId: string): Promise<boolean> {
  if (!workspace) return false
  try {
    await workspace.openSession(sessionId)
    if (globalThis.location?.hash.startsWith('#orchestra/')) globalThis.history.replaceState(null, '', `${location.pathname}${location.search}`)
    return true
  } catch { return false }
}
