/** Cordis-style grant: root service reads throw, injection may arrive later, child effects dispose. */
export function strictCordis<T extends Record<string, unknown>>(staticFaces: T, services: Record<string, unknown> = {}) {
  const pending = new Map<string, Array<(child: unknown) => void>>()
  const effects: Array<() => void> = []
  const scopes = new Map<string, Array<() => void>>()
  const serviceNames = ['layout', 'locale', 'settings', 'sessionController', 'webServer']
  const root = {
    ...staticFaces,
    get(name: string) {
      if (serviceNames.includes(name)) throw new Error(`cannot get property "${name}" without inject`)
      return (staticFaces as Record<string, unknown>)[name]
    },
    inject(names: readonly string[], callback: (child: unknown) => void) {
      const name = names[0]!
      const list = pending.get(name) ?? []
      list.push(callback)
      pending.set(name, list)
      if (name in services) grant(name, services[name])
    },
    effect(fn: () => (() => void) | undefined) { const dispose = fn(); if (dispose) effects.push(dispose) },
  }
  for (const name of serviceNames) Object.defineProperty(root, name, {
    get() { throw new Error(`cannot get property "${name}" without inject`) },
  })
  function grant(name: string, value: unknown) {
    services[name] = value
    for (const callback of pending.get(name) ?? []) {
      const owned: Array<() => void> = []
      const child = {
        ...staticFaces,
        [name]: value,
        effect(fn: () => (() => void) | undefined) { const dispose = fn(); if (dispose) owned.push(dispose) },
      }
      callback(child)
      const previous = scopes.get(name) ?? []
      scopes.set(name, [...previous, ...owned])
    }
  }
  function revoke(name: string) {
    delete services[name]
    for (const dispose of scopes.get(name) ?? []) dispose()
    scopes.delete(name)
  }
  function dispose() {
    for (const name of scopes.keys()) revoke(name)
    for (const effect of effects) effect()
  }
  return { root, grant, revoke, dispose }
}
