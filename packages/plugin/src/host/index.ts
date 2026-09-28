import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Backends, createBackends, deriveViews, loadPlan, loadRepoPreferences, loadSidebarOrder, nodeExec, normalize, readDshWorkspaces, readRepoRegistry, workerSettingsProblem } from '@crewboard/core'
import { actionRoutes, dshCatalogOf, resolvedWorkers } from './actions.js'
import { assetRoutes } from './assets.js'
import { type ChatDeps, createChatWaker, readChats } from './chat.js'
import { Config, legacyDshConfigFromYaml, resolveConfigWithLegacy } from './config.js'
import type { HostContext, SessionControllerFace } from './dsh.js'
import { macNative, type Native } from './native.js'
import { dshHomeOf, watchDshSettings } from './dsh-settings.js'
import { bindHostService, reportHostBoundary } from './boundary.js'
import { hostLang } from './i18n.js'
import { createAttentionNotifier } from './notify.js'
import { ORCHESTRA_PROMPT, ORCHESTRA_PROMPT_NAME, ORCHESTRA_PROMPT_ORDER } from './prompt.js'
import { createNotificationPresence } from './presence.js'
import { orchestraRoutes } from './routes.js'
import { OrchestraService, type ServiceDeps } from './service.js'
import { orchestraTools, toDshTool } from './tools.js'

export { Config }

export const name = 'crewboard'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx: HostContext, rawConfig?: unknown, dependencies?: { native?: Native; onService?: (service: OrchestraService) => void; profile?: ServiceDeps['profile'] }): void {
  const home = process.env.HOME ?? homedir()
  // dsh passes only the current plugin row to apply(). Recover the previous row's repos
  // from its profile patch so changing plugin ids does not drop the owner's repository list.
  let legacyConfig: ReturnType<typeof legacyDshConfigFromYaml>
  try {
    const yaml = readFileSync(join(home, '.dsh', 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    legacyConfig = legacyDshConfigFromYaml(yaml)
  } catch { /* no old settings on a fresh install */ }
  const config = resolveConfigWithLegacy(rawConfig, legacyConfig, process.env)
  // The repositories dsh itself serves: read fresh from dsh's own registry on every traversal, so a
  // workspace added (or removed) in dsh shows up without restarting the plugin.
  const workspaces = () => readDshWorkspaces(home)
  // Crewboard's own list (`crewboard init`, `repo add`, the screen's «+»), with the same freshness.
  const registered = () => readRepoRegistry(process.env, home)
  const cache = new Map<string, Backends>()
  const backendsFor = (root: string): Backends => {
    let b = cache.get(root)
    if (!b) {
      b = createBackends({ env: process.env, home, exec: nodeExec, root })
      cache.set(root, b)
    }
    return b
  }

  let settings: { get(namespace: string): unknown } | undefined
  bindHostService(ctx, 'settings', (face) => {
    settings = face
    return () => { if (settings === face) settings = undefined }
  })
  const lang = () => {
    try {
      const value = settings?.get('locale')
      const preference = value && typeof value === 'object' ? (value as { preference?: unknown }).preference : undefined
      return hostLang(preference)
    } catch (error) { reportHostBoundary('settings', 'callback', error); return 'en' as const }
  }
  // The session controller is optional: without it every chat route answers 503, dsh's models are not
  // listed, and the plugin works exactly as before.
  let sessions: SessionControllerFace | undefined

  // The chat bindings live next to the plan and are read when the snapshot is built, so the client
  // can show which plans already have one. The worker list carries every model dsh's catalog lists (pv1).
  const service = new OrchestraService({ config, backendsFor, now: () => new Date(), chatsFor: readChats, workspaces, registered, workersFor: async () => resolvedWorkers(process.env, home, { ...await dshCatalogOf(sessions).then((catalog) => (catalog ? { catalog } : {})), lang: lang() }), workerSettingsFor: () => workerSettingsProblem(process.env, home), prefsFor: () => loadRepoPreferences(process.env, home), orderFor: () => loadSidebarOrder(process.env, home), env: { ...process.env, HOME: home }, ...(dependencies?.profile ? { profile: dependencies.profile } : {}) })
  const stop = service.start()
  dependencies?.onService?.(service)
  ctx.effect(() => stop, 'crewboard: service')

  const native = dependencies?.native ?? macNative(nodeExec)
  // dsh hot-reloads its providers from `settings.yaml` (what Settings → Models writes): the worker list follows.
  ctx.effect(() => watchDshSettings(dshHomeOf(process.env, home), () => void service.refresh()), 'crewboard: dsh settings')
  // While a browser tab promises to show notifications, the host stays quiet; when the last such
  // client stops heart-beating the macOS fallback takes over again.
  const presence = createNotificationPresence()
  if (config.notifications) {
    // Work that waits on the person, grouped by plan and reason — one notification per change (at2).
    const notifier = createAttentionNotifier((title, message) => native.notify(title, message), lang, () => !presence.active())
    ctx.effect(() => {
      const stop = service.subscribe((s) => {
        notifier(s)
      })
      return () => {
        stop()
        notifier.dispose()
      }
    }, 'crewboard: notifications')
  }

  ctx.effect(() => ctx.systemPrompt.section({ name: ORCHESTRA_PROMPT_NAME, order: ORCHESTRA_PROMPT_ORDER, text: ORCHESTRA_PROMPT }), 'crewboard: prompt section')

  const tools = orchestraTools({ service, repos: config.repos, workspaces, backendsFor, env: process.env, home, now: () => new Date(), lang })
  for (const spec of tools) ctx.effect(() => ctx.tools.register(toDshTool(spec)), `crewboard: ${spec.name}`)

  // The task brief wants the latest events; only the host has the run backends, so it reads them here.
  const readTask: ChatDeps['readTask'] = async (root, planId, taskId) => {
    const plan = await loadPlan(root, planId).catch(() => undefined)
    const view = plan ? deriveViews(plan).find((v) => v.task.id === taskId) : undefined
    if (!view) return undefined
    const task = view.task
    const run = task.runs.at(-1)
    const events = run ? await backendsFor(root).forAgent(run.agent, run.runId).then((b) => b.events(run.runId)).catch(() => []) : []
    return {
      task: { id: task.id, title: task.title, status: view.status, ...(task.worker ? { worker: task.worker } : {}), ...(task.contract ? { contract: task.contract } : {}) },
      lastEvents: normalize(events).slice(-5).map((e) => e.text),
    }
  }

  // The waker only exists while the session controller is injected.
  ctx.inject(['sessionController'], (chat) => {
    const controller = chat.sessionController
    if (!controller) return
    sessions = controller
    // The catalog just became readable: list dsh's models now rather than at the next refresh.
    void service.refresh()
    const waker = createChatWaker({ sessions: controller, now: () => new Date(), newId: () => randomUUID(), readTask })
    chat.effect(() => service.subscribe((s) => waker(s)), 'crewboard: chat waker')
    chat.effect(
      () => () => {
        sessions = undefined
      },
      'crewboard: session controller',
    )
  })

  const routes = [
    ...orchestraRoutes(service, { presence }),
    ...actionRoutes({
      service,
      repos: config.repos,
      workspaces,
      backendsFor,
      native,
      env: process.env,
      home,
      now: () => new Date(),
      sessions: () => sessions,
      newId: () => randomUUID(),
      readTask,
      lang,
    }),
    ...assetRoutes(),
  ]
  ctx.inject(['webServer'], (child) => {
    for (const route of routes) {
      child.effect(() => child.webServer?.register(route) ?? (() => {}), `crewboard: ${route.path}`)
    }
  })
}
