import { t } from './i18n.js'
import type { TaskClass } from '../shared/types.js'

// The client bundle carries no core runtime (types only), so the four class labels and the
// kind → class fallback are mirrored from core/src/routing/routing.ts. Keep the two in sync.
export const CLASS_LABEL: Record<TaskClass, string> = {
  get code() { return t('settings.class.code') },
  get design() { return t('settings.class.design') },
  get review() { return t('settings.class.review') },
  get research() { return t('settings.class.research') },
}

/** The class a task is routed to when launched without an explicit worker. */
export function classOfTask(task: { kind: string; class?: TaskClass }): TaskClass {
  if (task.class) return task.class
  if (task.kind === 'review') return 'review'
  if (task.kind === 'research') return 'research'
  return 'code'
}
