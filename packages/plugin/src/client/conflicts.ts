import type { TaskSnapshot } from '../shared/types.js'
import { t } from './i18n.js'

type Conflict = NonNullable<TaskSnapshot['conflicts']>[number]

/** The first paths of a conflict, then how many more (mg1). */
const paths = (list: readonly string[]) => (list.length > 3 ? `${list.slice(0, 3).join(', ')} (+${list.length - 3})` : list.join(', '))

/** «conflicts with main in src/a.ts» / «conflicts with task b in src/a.ts». */
export function conflictLabel(conflict: Conflict): string {
  return conflict.with === 'base'
    ? t('panel.task.conflictBase', { into: conflict.into, paths: paths(conflict.paths) })
    : t('panel.task.conflictTask', { task: conflict.taskId, paths: paths(conflict.paths) })
}

/** The ready Send back text: bring the branch up to date with its base, naming what conflicts. */
export function conflictSendBack(conflicts: readonly Conflict[], base: string): string {
  const into = conflicts.find((c) => c.into)?.into ?? base
  const list = conflicts.map((c) => c.with === 'base'
    ? t('panel.task.conflictItBase', { into: c.into, paths: paths(c.paths) })
    : t('panel.task.conflictItTask', { task: c.taskId, paths: paths(c.paths) })).join('; ')
  return t('panel.task.conflictText', { into, list })
}
