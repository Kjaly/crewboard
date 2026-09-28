import { shellLabel, subscribeLang } from './i18n.js'
import { PANEL_ID } from '../shared/types.js'
import type { ClientContext, SlotsFace } from './dsh.js'
import { startReviewCenter } from './notify.js'
import { OrchestraIcon, OrchestraPanel } from './panel.js'
import { registerRightPaneTab } from './right-pane.js'
import { bindWorkspace } from './layout.js'
import { OrchestraSettings } from './lazy-views.js'
import * as sharedI18n from './i18n.js'
import * as sharedStore from './store.js'
import * as sharedLayout from './layout.js'
import * as sharedStyles from './styles.js'
import * as sharedAttention from './attention.js'
import * as sharedApi from './api.js'
import * as sharedGraphView from './views/graph/graph-view.js'
import { bindLocale } from './i18n.js'

declare const require: (id: string) => unknown
const shellRequire = require
// The screen bundles take these from the main client instead of carrying a copy (scripts/build.mjs).
const shared: Record<string, unknown> = {
  '__orchShared/i18n': sharedI18n,
  '__orchShared/store': sharedStore,
  '__orchShared/layout': sharedLayout,
  '__orchShared/styles': sharedStyles,
  '__orchShared/attention': sharedAttention,
  '__orchShared/api': sharedApi,
  '__orchShared/graph-view': sharedGraphView,
}
;(globalThis as any).__orchScreenRequire = (id: string) => shared[id] ?? shellRequire(id)
import { orchestraStore } from './store.js'

export const name = `${PANEL_ID}/client`
export const inject = ['slots']

/** Mount problems must never throw: the dsh web shell fails the whole boot when a plugin apply throws. */
export function apply(ctx: ClientContext): void {
  bindWorkspace(ctx)
  // Slots register synchronously: the shell may read them once at boot. A React body (OrchestraIcon,
  // OrchestraSettings) fills in on its own once the dictionary arrives — useLang re-renders it. A
  // `label`/`title` dsh calls itself, outside React, never returns blank (shellLabel, lb1) and is
  // re-registered once the dictionary lands or the language changes (registerRelabeled).
  mountOrchestra(ctx)
  bindLocale(ctx)
}

/**
 * Registers a list-slot entry whose `label` dsh calls at its own render points — an entries change,
 * or its own locale switching (lb1) — never because our lazy dictionary landed. `settings.section`'s
 * own contract names the fix: re-registering bumps dsh's re-render trigger, so the freshest text (once
 * `shellLabel` can read a landed dictionary through `t()`) reaches the row without dsh subscribing to
 * our locale state itself. `label` already never returns blank (`shellLabel`); this only asks dsh to
 * read it again sooner than its own next render would.
 */
function registerRelabeled(slots: SlotsFace, options: Record<string, unknown>, component: unknown): () => void {
  let dispose = slots.register(options, component)
  const unsubscribe = subscribeLang(() => {
    dispose()
    dispose = slots.register(options, component)
  })
  return () => {
    unsubscribe()
    dispose()
  }
}

function mountOrchestra(ctx: ClientContext): void {
  const slots = ctx.get?.('slots') as SlotsFace | undefined
  if (!slots) return
  try {
    startReviewCenter(ctx)
  } catch {
    /* notifications are a courtesy — a failure here must not take the panel down with it */
  }
  slots.inject('sidebar.panellist', () => registerRelabeled(slots, { name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => shellLabel('notify.badge') }, OrchestraIcon))
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, OrchestraPanel))
  orchestraStore.startRouting()
  slots.inject('settings.section', () =>
    registerRelabeled(slots, { name: 'settings.section', id: PANEL_ID, order: 40, label: () => shellLabel('settings.section') }, OrchestraSettings),
  )
  // Optional right-pane tab (task 2k/3 draws the panel). Absent registry = nothing registered, never a throw.
  registerRightPaneTab(ctx, slots)
}
