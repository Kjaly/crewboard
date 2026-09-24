import { t } from './i18n.js'
import { PANEL_ID } from '../shared/types.js'
import type { ClientContext, SlotsFace } from './dsh.js'
import { reviewBadgeLabel, startReviewCenter } from './notify.js'
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
  // Slots register synchronously: the shell may read them once at boot. Text fills in when the
  // dictionary arrives (t() is blank until then and useLang re-renders).
  mountOrchestra(ctx)
  bindLocale(ctx)
}

function mountOrchestra(ctx: ClientContext): void {
  const slots = ctx.get?.('slots') as SlotsFace | undefined
  if (!slots) return
  try {
    startReviewCenter(ctx)
  } catch {
    /* notifications are a courtesy — a failure here must not take the panel down with it */
  }
  slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 100, label: () => reviewBadgeLabel() }, OrchestraIcon))
  slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, OrchestraPanel))
  orchestraStore.startRouting()
  slots.inject('settings.section', () =>
    slots.register({ name: 'settings.section', id: PANEL_ID, order: 40, label: () => t('settings.section') }, OrchestraSettings),
  )
  // Optional right-pane tab (task 2k/3 draws the panel). Absent registry = nothing registered, never a throw.
  registerRightPaneTab(ctx, slots)
}
