import { createElement, useEffect, useState, type ComponentType } from 'react'
import { t } from './i18n.js'

type Bundle = Record<string, ComponentType<any>>
declare global { var __orchScreenBundles: Record<string, Bundle> | undefined }
const paths: Record<string, string> = {
  review: '/crewboard/assets/screen-review.js',
  welcome: '/crewboard/assets/screen-welcome.js',
  settings: '/crewboard/assets/screen-settings.js',
  draft: '/crewboard/assets/screen-draft.js',
  ledger: '/crewboard/assets/screen-ledger.js',
  trace: '/crewboard/assets/screen-trace.js',
  task: '/crewboard/assets/screen-task.js',
  graph: '/crewboard/assets/screen-graph.js',
}
const pending = new Map<string, Promise<Bundle>>()

function load(name: string): Promise<Bundle> {
  const ready = globalThis.__orchScreenBundles?.[name]
  if (ready) return Promise.resolve(ready)
  const existing = pending.get(name)
  if (existing) return existing
  const promise = new Promise<Bundle>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = paths[name] ?? `/crewboard/assets/screen-${name}.js`
    script.async = true
    script.onload = () => {
      const bundle = globalThis.__orchScreenBundles?.[name]
      bundle ? resolve(bundle) : reject(new Error(`Screen ${name} did not register`))
    }
    script.onerror = () => reject(new Error(`Screen ${name} could not load`))
    document.head.append(script)
  }).catch((error) => { pending.delete(name); throw error })
  pending.set(name, promise)
  return promise
}

export function lazyScreen<Props extends object>(name: string, key: string): ComponentType<Props> {
  return function LazyScreen(props: Props) {
    const [revision, retry] = useState(0)
    const [state, setState] = useState<{ component?: ComponentType<Props>; error?: boolean }>(() => ({ component: globalThis.__orchScreenBundles?.[name]?.[key] }))
    // biome-ignore lint/correctness/useExhaustiveDependencies: The listed key intentionally triggers a refresh when its underlying data changes.
    useEffect(() => {
      let live = true
      if (state.component) return
      void load(name).then((bundle) => { if (live) setState({ component: bundle[key] as ComponentType<Props> }) }).catch(() => { if (live) setState({ error: true }) })
      return () => { live = false }
    }, [revision, state.component])
    if (state.component) return createElement(state.component, props)
    if (state.error) return <p role="alert">{t('panel.app.screenLoadError')} <button type="button" onClick={() => { setState({}); retry((n) => n + 1) }}>{t('review.retry')}</button></p>
    return <p role="status">{t('panel.app.screenLoading')}</p>
  }
}
