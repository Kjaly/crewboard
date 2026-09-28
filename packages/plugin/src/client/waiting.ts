import type { OrchestraSnapshot } from '../shared/types.js'
import { type NeedsYouOpen, type NeedsYouReason, type NeedsYouReasons, needsYou, reasonParts, type WaitingCounts, waitingCounts } from '../../../core/src/orchestration/needs-you.js'
import { t } from './i18n.js'

/**
 * The screen's words for the one waiting model (at2, B25). Every count the screen shows — the sidebar,
 * the tab title and favicon, toasts, the review chip and Review — comes from `waitingOf`, and every
 * label says its scope and its reasons the same way.
 */

/** The counts of one snapshot; `open` adds the open plan's own count. */
export const waitingOf = (snapshot: Pick<OrchestraSnapshot, 'repos'> | null | undefined, open?: NeedsYouOpen): WaitingCounts =>
  waitingCounts(needsYou(snapshot?.repos ?? [], open), open)

/** «in this plan 7 · all 13», or «all 13» without an open plan. */
export const scopeText = (counts: Pick<WaitingCounts, 'all' | 'plan'>): string =>
  counts.plan === undefined ? t('waiting.all', { all: counts.all }) : t('waiting.scope', { plan: counts.plan, all: counts.all })

/** «6 tasks wait for review · 1 decision»; empty when nothing waits. */
export const reasonsText = (reasons: Partial<NeedsYouReasons>): string =>
  reasonParts(reasons).map(([reason, count]) => t(`waiting.reason.${reason}`, { count })).join(' · ')

/** The short tag next to a row's title. */
export const reasonTag = (reason: NeedsYouReason): string => t(`waiting.tag.${reason}`)
