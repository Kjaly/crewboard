import { lazyScreen } from './lazy-screen.js'
import type { ComponentProps } from 'react'
import type { ReviewView as ReviewViewType } from './views/review.js'
import type { ReviewDrilldown as ReviewDrilldownType } from './views/review-detail.js'
import type { Welcome as WelcomeType } from './welcome.js'
import type { Tour as TourType } from './tour.js'
import type { DraftReview as DraftReviewType } from './draft-review.js'
import type { DraftJobView as DraftJobViewType } from './draft-job.js'
import type { LedgerView as LedgerViewType } from './panel/trace-ledger.js'
import type { TraceScreen as TraceScreenType } from './panel/trace.js'
import type { TaskPanel as TaskPanelType } from './panel/task-panel.js'
import type { TaskMenu as TaskMenuType } from './task-menu.js'

export const ReviewView = lazyScreen<ComponentProps<typeof ReviewViewType>>('review', 'ReviewView')
export const ReviewDrilldown = lazyScreen<ComponentProps<typeof ReviewDrilldownType>>('review', 'ReviewDrilldown')
export const Welcome = lazyScreen<ComponentProps<typeof WelcomeType>>('welcome', 'Welcome')
export const Tour = lazyScreen<ComponentProps<typeof TourType>>('welcome', 'Tour')
export const OrchestraSettings = lazyScreen<{}>('settings', 'OrchestraSettings')
export const DraftReview = lazyScreen<ComponentProps<typeof DraftReviewType>>('draft', 'DraftReview')
export const DraftJobView = lazyScreen<ComponentProps<typeof DraftJobViewType>>('draft', 'DraftJobView')
export const LedgerView = lazyScreen<ComponentProps<typeof LedgerViewType>>('ledger', 'LedgerView')
export const TraceScreen = lazyScreen<ComponentProps<typeof TraceScreenType>>('trace', 'TraceScreen')
export const TaskPanel = lazyScreen<ComponentProps<typeof TaskPanelType>>('task', 'TaskPanel')
export const TaskMenu = lazyScreen<ComponentProps<typeof TaskMenuType>>('task', 'TaskMenu')
// The graph is the default view: it stays in the main bundle so a cold start never shows a loader.
export { GraphView } from './views/graph/index.js'
