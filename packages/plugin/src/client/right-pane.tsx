import { t, useLang } from './i18n.js'
// (body and live chip title into the keyed `sidebar.right.pane.tab[.title]` seats, under the type's
// `id`). The body is the workspace panel from `right-panel.tsx`; the wiring is the minimal,
// optional registration researched in docs/notes/2026-09-22-dsh-right-pane.md. The registry is
// optional by contract: an older dsh line without it leaves the tab unregistered instead of
// failing the plugin boot.
import { PANEL_ID } from '../shared/types.js'
import type { ClientContext, SlotsFace } from './dsh.js'
import { selectMainPanel } from './layout.js'
import { RightPanel, rightPanelHost, type RightPanelProps } from './right-panel.js'

/** Implementation identity (`definition.id`) and the page kind `openTab` names. Namespaced like `dsh-context`. */
export const ORCHESTRA_TAB_ID = PANEL_ID
export const ORCHESTRA_TAB_KIND = PANEL_ID
/** Tab chip and guide capsule label. Live label for the tab chip and guide capsule. */
export const ORCHESTRA_TAB_LABEL = 'Orchestration'

/** The stage-one definition, narrowed to the fields this registration uses (`SidebarRightTabDefinition`). */
type TabDefinition = {
  readonly id: string
  readonly kind: string
  readonly title: (address: string) => string
  readonly guide?: readonly {
    readonly order: number
    readonly title: () => string
    readonly description?: () => string
  }[]
}

/** The `ctx.sidebarRightTabs` face (`SidebarRightTabRegistry`). */
type TabRegistryFace = { register(definition: TabDefinition): () => void }

/** `ctx.inject(deps, callback)`: cordis runs the callback once the services are available. */
type DeferredInject = (deps: readonly string[], callback: (ctx: unknown) => void) => unknown

/** The optional services this tab needs; absent means this dsh line serves no right-pane tab registry. */
type RightPaneContext = ClientContext & {
  readonly inject?: DeferredInject
  readonly sidebarRightTabs?: TabRegistryFace
}

/**
 * The tab body: the workspace plan next to the chat. The seat is session-scoped, so the shell
 * hands the body `sessionId` and `useSessions` as ordinary props — the panel reads the session's
 * cwd and shows that workspace's plan.
 */
export function OrchestraTabBody(props: RightPanelProps) {
  return <RightPanel {...props} />
}

/** The live chip title; a type may also leave the title captured at open time, but keeping it live matches our label. */
export function OrchestraTabTitle() {
  useLang()
  return <span className="orc-rp__chip">{t('panel.tab')}</span>
}

/** Register the type and both keyed seats, once the registry is provably present. */
function registerOn(raw: RightPaneContext, slots: SlotsFace): void {
  // registration captures it for them — the same seam the review center uses for its toasts.
  rightPanelHost.selectPanel = (key) => selectMainPanel(key)
  const tabs = raw.sidebarRightTabs
  if (!tabs || typeof tabs.register !== 'function') return
  tabs.register({
    id: ORCHESTRA_TAB_ID,
    kind: ORCHESTRA_TAB_KIND,
    title: () => t('panel.tab'),
    // A page type claims no address; the guide capsule is how a human opens it by hand.
    guide: [{ order: 30, title: () => t('panel.tab'), description: () => t('panel.guide') }],
  })
  slots.inject('sidebar.right.pane.tab', () =>
    slots.register({ name: 'sidebar.right.pane.tab', key: ORCHESTRA_TAB_ID }, OrchestraTabBody),
  )
  slots.inject('sidebar.right.pane.tab.title', () =>
    slots.register({ name: 'sidebar.right.pane.tab.title', key: ORCHESTRA_TAB_ID }, OrchestraTabTitle),
  )
}

/**
 * Reached through a deferred inject (so a late-provided registry still lands), with a direct read as
 * the fallback. Never throws: the tab is optional, apply must not take the whole boot down.
 */
export function registerRightPaneTab(ctx: ClientContext, slots: SlotsFace): void {
  const own = (raw: unknown) => {
    try {
      registerOn(raw as RightPaneContext, slots)
    } catch {
      /* the tab is a courtesy; a hostile registry must not break the panel */
    }
  }
  const inject = (ctx as RightPaneContext).inject
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['sidebarRightTabs'], own)
    } catch {
      /* same guard as above */
    }
    return
  }
  own(ctx)
}
